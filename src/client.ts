import JSZip from "jszip";
import {
  HEADERS,
  Host,
  Endpoint,
  Action,
  DirectorTools,
  EmotionOptions,
  EmotionLevel,
  Model,
  StreamingType,
  TextModel,
  isV4Model,
  isV5Model,
} from "./constants";
import { Image, MsgpackEvent } from "./image";
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatMessage,
  Completion,
  CompletionPrompt,
  DirectorRequest,
  EncodeVibeOptions,
  EncodeVibeRequest,
  EnhanceOptions,
  GenerateImageOptions,
  GenerateVoiceOptions,
  ImageGenerationJsonResponse,
  ImageInput,
  LMGenerationResponse,
  Metadata,
  NativeTextOptions,
  NovelAIOptions,
  OAITokenCountResponse,
  OpenAIModelInfo,
  OpenAIModelsResponse,
  TagSuggestion,
  TextGenerationOptions,
  UpscaleOptions,
  VoiceResult,
} from "./types";
import {
  buildImagePayload,
  calculateCost,
  createFilename,
  decodeBufferedImageResponse,
  decodeImageStream,
  getNodeFs,
  imageExtension,
  isNodeEnvironment,
  NovelAIStreamError,
  parseImage,
  SSEStream,
  scaleDimensions,
  timestampString,
  uint8ArrayToBase64,
} from "./utils";
import { NovelAITransport } from "./utils/transport";
import { metadataProcessor } from "./metadata";

/** Maximum number of vibe tokens kept in the in-memory cache */
const VIBE_CACHE_LIMIT = 100;

const DECLARED_BLUR_SIGMAS = [0, 0.3, 0.35, 0.4, 0.45, 0.5] as const;

/**
 * Detect whether a base64 string is an actual image (needing vibe encoding)
 * rather than a pre-encoded vibe token.
 */
function isEncodableImage(base64: string): boolean {
  return ["iVBOR", "/9j/", "UklGR", "R0lGO"].some((magic) =>
    base64.startsWith(magic),
  );
}

/**
 * Copy of a request payload with bulky base64 fields replaced by size
 * annotations, for verbose logging.
 */
function redactPayload(payload: any): any {
  const params = payload?.parameters;
  if (!params) return payload;

  const redact = (value: unknown) =>
    typeof value === "string" ? `<base64: ${value.length} chars>` : value;

  const redacted: any = { ...params };
  for (const key of ["image", "mask", "reference_image"]) {
    if (redacted[key] !== undefined) redacted[key] = redact(redacted[key]);
  }
  for (const key of ["reference_image_multiple", "director_reference_images"]) {
    if (Array.isArray(redacted[key])) {
      redacted[key] = redacted[key].map(redact);
    }
  }
  return { ...payload, parameters: redacted };
}

/**
 * NovelAI client for image generation, Director tools, text and voice.
 */
export class NovelAI {
  private token: string;
  private host: string;
  private textHost: string;
  private timeout: number;
  private verbose: boolean;
  private transport: NovelAITransport;

  /**
   * Cache of vibe tokens to avoid re-encoding the same images.
   */
  private vibeCache: Map<string, string> = new Map();

  constructor(options: NovelAIOptions) {
    this.token = options.token;
    this.host = options.host || Host.IMAGE;
    this.textHost = options.textHost || Host.TEXT;
    this.timeout = options.timeout || 120000;
    this.verbose = options.verbose || false;

    this.transport = new NovelAITransport({
      headers: {
        ...HEADERS,
        Authorization: `Bearer ${this.token}`,
      },
      timeout: this.timeout,
      retry: options.retry,
      verbose: this.verbose,
    });
  }

  /**
   * Generate images.
   *
   * @param metadata - Generation parameters
   * @param options - Streaming / response-format options
   */
  generateImage(
    metadata: Metadata,
    options?: GenerateImageOptions & { stream?: false },
  ): Promise<Image[]>;
  generateImage(
    metadata: Metadata,
    options: GenerateImageOptions & { stream: true },
  ): Promise<AsyncGenerator<MsgpackEvent, void, unknown>>;
  async generateImage(
    metadata: Metadata,
    options: GenerateImageOptions = {},
  ): Promise<Image[] | AsyncGenerator<MsgpackEvent, void, unknown>> {
    const resolved = await this.resolveImageInputs(metadata);
    const processedMetadata = metadataProcessor.processMetadata(resolved);
    const model = processedMetadata.model!;

    if (options.stream && !isV4Model(model)) {
      throw new Error(
        "Streaming is only supported for V4/V5 models; V3 models return the final image only.",
      );
    }

    if (this.verbose) {
      if (isV5Model(model)) {
        console.info("Generating V5 image; check account usage for cost");
      } else {
        const cost = calculateCost(processedMetadata, options.isOpus);
        console.info(`Generating image... estimated Anlas cost: ${cost}`);
      }
    }

    await this.encodeVibeMetadata(processedMetadata);

    const payload = buildImagePayload(processedMetadata);
    if (this.verbose) {
      console.debug(
        `[Image payload] ${payload.model}`,
        JSON.stringify(redactPayload(payload)),
      );
    }

    try {
      if (options.stream) {
        const streamFormat = options.streamFormat ?? StreamingType.SSE;
        payload.parameters.stream = streamFormat;
        const accept =
          streamFormat === StreamingType.SSE
            ? "text/event-stream"
            : "application/octet-stream";
        const { response } = await this.transport.stream(
          `${this.host}${Endpoint.IMAGE_STREAM}`,
          { body: payload, accept, idempotent: false },
        );
        return this.wrapImageStream(
          decodeImageStream(
            response.body!,
            response.headers.get("content-type") ?? undefined,
          ),
        );
      }

      if (options.format === "json") {
        delete payload.parameters.stream;
        const result = await this.transport.json<ImageGenerationJsonResponse>(
          `${this.host}${Endpoint.IMAGE}`,
          { body: payload, accept: "application/json", idempotent: false },
        );
        return this.imagesFromJson(result);
      }

      delete payload.parameters.stream;
      const { data, contentType } = await this.transport.buffer(
        `${this.host}${Endpoint.IMAGE}`,
        { body: payload, accept: "application/zip", idempotent: false },
      );
      return await decodeBufferedImageResponse(data, contentType);
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  private imagesFromJson(result: ImageGenerationJsonResponse): Image[] {
    if (!Array.isArray(result?.images) || result.images.length === 0) {
      throw new NovelAIStreamError("JSON image response contained no images");
    }
    return result.images.map((entry) => {
      const data = Uint8Array.from(atob(entry.image), (c) => c.charCodeAt(0));
      return new Image({
        filename: `${timestampString()}_p${entry.index}.${imageExtension(data)}`,
        data,
        seed: entry.seed,
        index: entry.index,
      });
    });
  }

  private async *wrapImageStream(
    stream: AsyncGenerator<MsgpackEvent, void, unknown>,
  ): AsyncGenerator<MsgpackEvent, void, unknown> {
    try {
      yield* stream;
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  /**
   * Resolve all image-bearing metadata fields to raw base64 strings.
   */
  private async resolveImageInputs(metadata: Metadata): Promise<Metadata> {
    const result: Metadata = { ...metadata };

    result.image = await this.resolveToBase64(result.image);
    result.mask = await this.resolveToBase64(result.mask);
    result.reference_image = await this.resolveToBase64(result.reference_image);

    if (result.reference_image_multiple) {
      result.reference_image_multiple = await Promise.all(
        result.reference_image_multiple.map(
          (img) => this.resolveToBase64(img) as Promise<string>,
        ),
      );
    }

    if (result.director_reference_images) {
      result.director_reference_images = await Promise.all(
        result.director_reference_images.map(
          (img) => this.resolveToBase64(img) as Promise<string>,
        ),
      );
    }

    return result;
  }

  /**
   * Convert an ImageInput to raw base64.
   */
  private async resolveToBase64(
    input?: ImageInput,
  ): Promise<string | undefined> {
    if (input == null) return undefined;

    if (typeof input === "string") {
      if (input.startsWith("data:")) {
        const comma = input.indexOf(",");
        return comma >= 0 ? input.slice(comma + 1) : input;
      }
      if (/^(https?|blob):/.test(input)) {
        return (await parseImage(input)).base64;
      }
      if (isNodeEnvironment()) {
        const fs = await getNodeFs();
        if (fs?.existsSync(input)) {
          return (await parseImage(input)).base64;
        }
      }
      return input;
    }

    return (await parseImage(input)).base64;
  }

  private handleRequestError(error: any): Error {
    if (error?.name === "AbortError") {
      return new Error(
        `Request timed out after ${this.timeout}ms. Consider setting a higher 'timeout' value when creating the NovelAI client.`,
      );
    }
    return error;
  }

  /**
   * Use a Director tool with the specified request.
   */
  async useDirectorTool(request: DirectorRequest): Promise<Image> {
    try {
      const { data } = await this.transport.buffer(
        `${this.host}${Endpoint.DIRECTOR}`,
        { body: request, accept: "application/zip", idempotent: false },
      );
      return new Image({
        filename: createFilename(request.req_type),
        data: await this.unzipSingleImage(data),
      });
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  private async unzipSingleImage(
    data: Uint8Array | ArrayBuffer,
  ): Promise<Uint8Array> {
    try {
      const zip = await JSZip.loadAsync(data);
      const firstFile = Object.values(zip.files).find((f) => !f.dir);
      return firstFile
        ? await firstFile.async("uint8array")
        : new Uint8Array(data);
    } catch {
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    }
  }

  private async createDirectorRequest(
    image: ImageInput,
    reqType: DirectorTools,
    additionalParams: Record<string, any> = {},
  ): Promise<Image> {
    const parsedImage = await parseImage(image);

    return this.useDirectorTool({
      req_type: reqType,
      width: parsedImage.width,
      height: parsedImage.height,
      image: parsedImage.base64,
      ...additionalParams,
    } as DirectorRequest);
  }

  async lineArt(image: ImageInput): Promise<Image> {
    return this.createDirectorRequest(image, DirectorTools.LINEART);
  }

  async sketch(image: ImageInput): Promise<Image> {
    return this.createDirectorRequest(image, DirectorTools.SKETCH);
  }

  async backgroundRemoval(image: ImageInput): Promise<Image> {
    return this.createDirectorRequest(image, DirectorTools.BACKGROUND_REMOVAL);
  }

  async declutter(image: ImageInput): Promise<Image> {
    return this.createDirectorRequest(image, DirectorTools.DECLUTTER);
  }

  async colorize(
    image: ImageInput,
    prompt: string = "",
    defry: number = 0,
  ): Promise<Image> {
    return this.createDirectorRequest(image, DirectorTools.COLORIZE, {
      prompt,
      defry,
    });
  }

  async changeEmotion(
    image: ImageInput,
    emotion: string = EmotionOptions.NEUTRAL,
    prompt: string = "",
    emotionLevel: EmotionLevel = EmotionLevel.NORMAL,
  ): Promise<Image> {
    return this.createDirectorRequest(image, DirectorTools.EMOTION, {
      prompt: `${emotion};;${prompt}`,
      defry: emotionLevel,
    });
  }

  /**
   * Upscale an image using the documented standalone upscaler.
   */
  async upscale(
    image: ImageInput,
    options: UpscaleOptions = {},
  ): Promise<Image> {
    const base64 = await this.resolveToBase64(image);
    if (!base64) {
      throw new Error("No image provided for upscaling");
    }

    if (
      options.declaredBlurSigma !== undefined &&
      !DECLARED_BLUR_SIGMAS.includes(options.declaredBlurSigma)
    ) {
      throw new Error(
        `declaredBlurSigma must be one of ${DECLARED_BLUR_SIGMAS.join(", ")}`,
      );
    }

    const body: Record<string, unknown> = {
      image: base64,
      model: options.model ?? Model.V4_5,
    };
    if (options.declaredBlurSigma !== undefined) {
      body.declared_blur_sigma = options.declaredBlurSigma;
    }

    try {
      const { data, contentType } = await this.transport.buffer(
        `${this.host}${Endpoint.UPSCALE}`,
        { body, accept: "application/zip", idempotent: false },
      );
      const images = await decodeBufferedImageResponse(data, contentType);
      if (images.length === 0) {
        throw new NovelAIStreamError("Upscale response contained no image");
      }
      return images[0];
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  /**
   * Enhance an image — img2img re-generation at a scaled-up resolution.
   */
  async enhance(
    image: ImageInput,
    options: EnhanceOptions = {},
  ): Promise<Image[]> {
    const { upscaleFactor = 1.5, strength = 0.5, noise = 0, ...rest } = options;
    const parsed = await parseImage(image);
    const [width, height] = scaleDimensions(
      parsed.width,
      parsed.height,
      upscaleFactor,
    );

    return this.generateImage({
      ...rest,
      action: Action.IMG2IMG,
      image: parsed.base64,
      width,
      height,
      strength,
      noise,
    });
  }

  /**
   * Get tag suggestions for a partial tag query.
   */
  async suggestTags(
    prompt: string,
    model: Model = Model.V4_5,
    lang?: "en" | "jp",
  ): Promise<TagSuggestion[]> {
    const url = new URL(`${this.host}${Endpoint.SUGGEST_TAGS}`);
    url.searchParams.set("model", model);
    url.searchParams.set("prompt", prompt);
    if (lang) url.searchParams.set("lang", lang);

    try {
      const result = await this.transport.json<{
        tags?: TagSuggestion[] | TagSuggestion;
      }>(url.toString(), { method: "GET" });
      return this.normalizeTagSuggestions(result?.tags);
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  private normalizeTagSuggestions(
    tags: TagSuggestion[] | TagSuggestion | undefined,
  ): TagSuggestion[] {
    if (Array.isArray(tags)) return tags;
    if (tags && typeof tags === "object" && "tag" in tags) return [tags];
    throw new Error("Unexpected suggest-tags response shape");
  }

  /**
   * Encode an image into a vibe-transfer token.
   */
  async encodeVibe(
    image: ImageInput,
    options: EncodeVibeOptions = {},
  ): Promise<string> {
    const base64 = await this.resolveToBase64(image);
    if (!base64) {
      throw new Error("No image provided for vibe encoding");
    }
    return this.fetchVibeToken(base64, options);
  }

  /**
   * Encode V4 reference images in-place before building the generation payload.
   */
  private async encodeVibeMetadata(metadata: Metadata): Promise<void> {
    if (!metadata.model || !isV4Model(metadata.model)) return;

    if (metadata.reference_image) {
      const reference = metadata.reference_image as string;
      if (isEncodableImage(reference)) {
        metadata.reference_image = await this.fetchVibeToken(reference, {
          model: metadata.model,
          informationExtracted: metadata.reference_information_extracted ?? 1,
        });
      }
    }

    if (!metadata.reference_image_multiple?.length) return;

    const encoded: string[] = [];
    for (let i = 0; i < metadata.reference_image_multiple.length; i++) {
      const refImage = metadata.reference_image_multiple[i] as string;
      if (!isEncodableImage(refImage)) {
        encoded.push(refImage);
        continue;
      }

      const info = metadata.reference_information_extracted_multiple?.[i] ?? 1;
      encoded.push(
        await this.fetchVibeToken(refImage, {
          model: metadata.model,
          informationExtracted: info,
        }),
      );
    }

    metadata.reference_image_multiple = encoded;
    delete metadata.reference_information_extracted_multiple;
  }

  private async fetchVibeToken(
    image: string,
    options: EncodeVibeOptions,
  ): Promise<string> {
    const model = options.model ?? Model.V4_5;
    const info = options.informationExtracted ?? 1;
    if (info < 0 || info > 1) {
      throw new Error("informationExtracted must be between 0 and 1");
    }

    const mask = await this.resolveToBase64(options.mask);
    const key = [
      await this.getImageHash(image),
      String(model),
      String(info),
      String(options.cropToMask ?? false),
      String(options.focusSeed ?? ""),
      String(options.infoExtractSeed ?? ""),
      mask ? await this.getImageHash(mask) : "",
    ].join(":");

    const cached = this.vibeCache.get(key);
    if (cached) return cached;

    const body: EncodeVibeRequest = {
      image,
      model: String(model),
      information_extracted: info,
    };
    if (mask) body.mask = mask;
    if (options.cropToMask !== undefined) body.crop_to_mask = options.cropToMask;
    if (options.focusSeed !== undefined) body.focus_seed = options.focusSeed;
    if (options.infoExtractSeed !== undefined) {
      body.info_extract_seed = options.infoExtractSeed;
    }

    try {
      const { data } = await this.transport.buffer(
        `${this.host}${Endpoint.ENCODE_VIBE}`,
        { body, accept: "application/octet-stream", idempotent: false },
      );
      const token = uint8ArrayToBase64(data);
      if (this.vibeCache.size >= VIBE_CACHE_LIMIT) {
        this.vibeCache.delete(this.vibeCache.keys().next().value!);
      }
      this.vibeCache.set(key, token);
      return token;
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  /**
   * SHA-256 hash of a base64 image, used as vibe cache key.
   */
  private async getImageHash(base64Image: string): Promise<string> {
    const binaryString = atob(base64Image);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // ---- Text generation ----

  /**
   * Generate a chat completion (non-streaming).
   */
  async chat(
    messages: string | ChatMessage[],
    options: TextGenerationOptions = {},
  ): Promise<ChatCompletion> {
    const body = {
      ...options,
      model: options.model ?? TextModel.GLM_4_6,
      messages: this.normalizeMessages(messages),
      stream: false,
    };

    try {
      return await this.transport.json<ChatCompletion>(
        `${this.textHost}${Endpoint.CHAT_COMPLETIONS}`,
        { body, idempotent: false },
      );
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  /**
   * Generate a chat completion as an OpenAI-style SSE stream.
   */
  async chatStream(
    messages: string | ChatMessage[],
    options: TextGenerationOptions = {},
  ): Promise<AsyncGenerator<ChatCompletionChunk, void, unknown>> {
    const body = {
      ...options,
      model: options.model ?? TextModel.GLM_4_6,
      messages: this.normalizeMessages(messages),
      stream: true,
    };

    try {
      const { response } = await this.transport.stream(
        `${this.textHost}${Endpoint.CHAT_COMPLETIONS}`,
        { body, accept: "text/event-stream", idempotent: false },
      );
      return this.parseChatStream(response);
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  /**
   * Generate a raw text completion via the OpenAI-compatible endpoint.
   */
  async completion(
    prompt: CompletionPrompt,
    options: TextGenerationOptions = {},
  ): Promise<Completion> {
    const body = {
      ...options,
      model: options.model ?? TextModel.GLM_4_6,
      prompt,
      stream: false,
    };
    try {
      return await this.transport.json<Completion>(
        `${this.textHost}${Endpoint.COMPLETIONS}`,
        { body, idempotent: false },
      );
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  /**
   * Generate text with the native `/ai/generate` protocol.
   */
  async generateText(
    prompt: string,
    options: NativeTextOptions = {},
  ): Promise<LMGenerationResponse> {
    const body = this.buildNativeTextRequest(prompt, options);
    try {
      return await this.transport.json<LMGenerationResponse>(
        `${this.textHost}${Endpoint.TEXT_GENERATE}`,
        { body, idempotent: false },
      );
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  /**
   * Generate text with the native `/ai/generate-stream` protocol.
   * Yields decoded token strings.
   */
  async generateTextStream(
    prompt: string,
    options: NativeTextOptions = {},
  ): Promise<AsyncGenerator<string, void, unknown>> {
    const body = this.buildNativeTextRequest(prompt, options);
    try {
      const { response } = await this.transport.stream(
        `${this.textHost}${Endpoint.TEXT_GENERATE_STREAM}`,
        { body, accept: "text/event-stream", idempotent: false },
      );
      return this.parseTextStream(response);
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  private buildNativeTextRequest(
    prompt: string,
    options: NativeTextOptions,
  ): Record<string, unknown> {
    const {
      model = TextModel.GLM_4_6,
      n_samples,
      prefix,
      max_length = 100,
      use_string = true,
      logit_bias_exp = [],
      ...rest
    } = options;

    if (
      !Number.isInteger(max_length) ||
      max_length < 1 ||
      max_length > 2048
    ) {
      throw new Error("max_length must be an integer between 1 and 2048");
    }

    const body: Record<string, unknown> = {
      input: prompt,
      model,
      parameters: {
        ...rest,
        max_length,
        use_string,
        logit_bias_exp,
      },
    };
    if (n_samples !== undefined) body.n_samples = n_samples;
    if (prefix !== undefined) body.prefix = prefix;
    return body;
  }

  /**
   * Count tokens using the OpenAI-compatible token-count extension.
   */
  async countTokens(
    prompt: string | string[],
    options: { model?: string } = {},
  ): Promise<OAITokenCountResponse> {
    try {
      return await this.transport.json<OAITokenCountResponse>(
        `${this.textHost}${Endpoint.TOKEN_COUNT}`,
        {
          body: {
            prompt,
            model: options.model ?? TextModel.GLM_4_6,
          },
          idempotent: true,
        },
      );
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  /**
   * List available text models with their full OpenAI model objects.
   */
  async listTextModels(): Promise<OpenAIModelInfo[]> {
    try {
      const result = await this.transport.json<OpenAIModelsResponse>(
        `${this.textHost}${Endpoint.TEXT_MODELS}`,
        { method: "GET", idempotent: true },
      );
      return Array.isArray(result?.data) ? result.data : [];
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  /**
   * Text-to-speech.
   */
  async generateVoice(options: GenerateVoiceOptions): Promise<VoiceResult> {
    if (!options.text) throw new Error("voice generation requires text");
    if (options.voice === undefined) {
      throw new Error("voice generation requires a voice id");
    }
    if (options.voice === -1 && !options.seed) {
      throw new Error("seed is required when voice is -1");
    }

    try {
      const { data, contentType } = await this.transport.buffer(
        `${this.host}${Endpoint.VOICE}`,
        {
          body: options,
          accept: "audio/webm, audio/mpeg",
          idempotent: false,
        },
      );
      return {
        data,
        mimeType: contentType.includes("webm") ? "audio/webm" : "audio/mpeg",
      };
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  private normalizeMessages(messages: string | ChatMessage[]): ChatMessage[] {
    return typeof messages === "string"
      ? [{ role: "user", content: messages }]
      : messages;
  }

  private async *parseChatStream(
    response: Response,
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const sse = new SSEStream();
    const reader = response.body!.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const event of sse.feed(value)) {
          if (event.data === "[DONE]") return;
          try {
            yield JSON.parse(event.data);
          } catch (error) {
            console.warn("Failed to parse chat stream chunk:", error);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async *parseTextStream(
    response: Response,
  ): AsyncGenerator<string, void, unknown> {
    const sse = new SSEStream();
    const reader = response.body!.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const event of sse.feed(value)) {
          if (event.data === "[DONE]") return;
          let parsed: any;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            continue;
          }
          if (parsed?.event_type === "error") {
            throw new NovelAIStreamError(
              String(parsed.message || "NovelAI text stream error"),
              { event: parsed },
            );
          }
          if (typeof parsed?.token === "string") yield parsed.token;
          else if (typeof parsed?.text === "string") yield parsed.text;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
