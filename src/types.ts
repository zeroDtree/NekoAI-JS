import {
  Action,
  Controlnet,
  Host,
  ImageFormat,
  Model,
  Noise,
  Resolution,
  Sampler,
  StreamingType,
} from "./constants";

/**
 * Configuration for API request retries.
 */
export interface RetryConfig {
  /**
   * Whether to enable retry for failed requests
   * @default true
   */
  enabled?: boolean;

  /**
   * Maximum number of retry attempts
   * @default 3
   */
  maxRetries?: number;

  /**
   * Base delay between retries in milliseconds.
   * Retries use exponential backoff (`baseDelay * 2^attempt`) plus jitter.
   * @default 1000
   */
  baseDelay?: number;

  /**
   * Maximum delay between retries in milliseconds
   * @default 30000
   */
  maxDelay?: number;

  /**
   * HTTP status codes that trigger a retry.
   *
   * `429` is deliberately not included: the API docs state that rate-limited
   * requests must not be retried, and retrying a generation may bill it twice.
   * Add `429` explicitly if the caller accepts that risk.
   * @default [500, 502, 503, 504]
   */
  retryStatusCodes?: number[];

  /**
   * Whether request timeouts / aborts should be retried. Disabled by default
   * because a timed-out generation may already have consumed Anlas.
   * @default false
   */
  retryOnTimeout?: boolean;

  /**
   * Whether transient network errors (fetch TypeError) should be retried.
   * Disabled automatically for non-idempotent generation requests.
   * @default true
   */
  retryNetworkErrors?: boolean;
}

// Character prompts types
export interface PositionCoords {
  x: number;
  y: number;
}

/**
 * Flexible image input types.
 */
export type ImageInput =
  | string // Path (Node.js), Data URL, remote URL, or raw base64
  | Blob
  | File
  | ArrayBuffer
  | Uint8Array
  | { data: Uint8Array }
  | { url: string }
  | HTMLImageElement
  | HTMLCanvasElement;

export interface ParsedImage {
  width: number;
  height: number;
  base64: string;
}

export interface CharacterCaption {
  char_caption: string;
  centers: PositionCoords[];
}

export interface CharacterPrompt {
  prompt: string;
  uc?: string;
  center?: PositionCoords;
  enabled?: boolean;
}

export interface V4CaptionFormat {
  base_caption: string;
  char_captions: CharacterCaption[];
}

export interface V4PromptFormat {
  caption: V4CaptionFormat;
  use_coords: boolean;
  use_order: boolean;
}

export interface V4NegativePromptFormat {
  caption: V4CaptionFormat;
  legacy_uc: boolean;
}

export interface V4ConditionInput {
  caption: V4CaptionFormat;
  legacy_uc?: boolean;
  use_coords?: boolean;
  use_order?: boolean;
}

/**
 * img2img sub-object sent alongside inpainting when the inpaint img2img
 * strength is below 1 (doc: `RequestParameters.img2img`).
 */
export interface Img2ImgParams {
  strength: number;
  color_correct: boolean;
  noise?: number;
  extra_noise_seed?: number;
}

/** Blur sigmas accepted by the standalone upscaler. */
export type DeclaredBlurSigma = 0 | 0.3 | 0.35 | 0.4 | 0.45 | 0.5;

export interface UpscaleParams {
  declared_blur_sigma?: DeclaredBlurSigma;
}

// Core metadata
export interface Metadata {
  // General parameters
  prompt?: string;
  model?: Model;
  action?: Action;
  resPreset?: Resolution;

  // Prompt settings
  negative_prompt?: string;
  qualityToggle?: boolean;
  ucPreset?: 0 | 1 | 2 | 3;

  // Image settings
  width?: number;
  height?: number;
  n_samples?: number;

  // AI settings
  steps?: number;
  scale?: number;
  dynamic_thresholding?: boolean;
  seed?: number;
  extra_noise_seed?: number;
  sampler?: Sampler;
  sm?: boolean;
  sm_dyn?: boolean;
  cfg_rescale?: number;
  noise_schedule?: Noise;

  // img2img / enhance settings
  /** Source image. Accepts any ImageInput (path, Blob, URL, raw base64, ...) */
  image?: ImageInput;
  strength?: number;
  img2img?: Img2ImgParams;
  noise?: number;
  /** Upscale factor sent with img2img requests (doc: `upscale`) */
  upscale?: UpscaleParams;
  /** Whether the source image was upscaled for enhance (doc: `upscaled_enhance`) */
  upscaled_enhance?: boolean;
  controlnet_strength?: number;
  controlnet_condition?: string;
  controlnet_model?: Controlnet;

  // Inpaint settings
  add_original_image?: boolean;
  /** Inpainting mask (white = repaint). Accepts any ImageInput */
  mask?: ImageInput;

  // Reference (single image) settings
  reference_image?: ImageInput;
  reference_information_extracted?: number;
  reference_strength?: number;

  // Vibe Transfer settings
  /** Reference images for vibe transfer. V4 models encode them automatically. */
  reference_image_multiple?: ImageInput[];
  reference_information_extracted_multiple?: number[];
  reference_strength_multiple?: number[];

  // Director reference (character reference / precise reference, V4.5)
  director_reference_images?: ImageInput[];
  /** For character reference: `base_caption` is "character" or "character&style" */
  director_reference_descriptions?: V4ConditionInput[];
  /** 0-1 per reference image */
  director_reference_information_extracted?: number[];
  /** 0-1 per reference image */
  director_reference_strength_values?: number[];
  /** Fidelity slider (0-1) per reference image */
  director_reference_secondary_strength_values?: number[];

  // V4/V4.5 specific settings
  params_version?: 1 | 2 | 3 | 4;
  autoSmea?: boolean;
  characterPrompts?: CharacterPrompt[];
  v4_prompt?: V4PromptFormat;
  v4_negative_prompt?: V4NegativePromptFormat;
  skip_cfg_above_sigma?: number | null;
  use_coords?: boolean;
  legacy_uc?: boolean;
  normalize_reference_strength_multiple?: boolean;
  deliberate_euler_ancestral_bug?: boolean;
  prefer_brownian?: boolean;

  // V4.5 specific settings
  /** Inpainting blend strength. Defaults to 1 for ordinary img2img. */
  inpaintImg2ImgStrength?: number;

  // Misc settings
  color_correct?: boolean;
  image_format?: ImageFormat;
  straight_alpha?: boolean;
  qualityPresetId?: "standard" | "light";
  ucPresetId?: string;
  tag_hint_qt?: number;
  tag_hint_uc_preset?: number;
  tag_hint_transparent_background?: boolean;
  legacy?: boolean;
  legacy_v3_extend?: boolean;

  stream?: StreamingType | null;
}

// Image related types
export interface ImageOptions {
  filename: string;
  data: Uint8Array;
  /** Seed reported by the JSON response, when available. */
  seed?: number;
  /** Index of this image in the response batch. */
  index?: number;
}

export interface ImageJson {
  image: string;
  index: number;
  seed: number;
}

export interface ImageGenerationJsonResponse {
  images: ImageJson[];
}

export interface ImageGenerationRequest {
  action: Action;
  input: string;
  model: Model;
  parameters: Record<string, unknown>;
  url?: string;
}

// Director Tools options

export interface DirectorRequestBase {
  req_type: string;
  width: number;
  height: number;
  image: string;
}

export interface LineArtRequest extends DirectorRequestBase {
  req_type: "lineart";
}

export interface SketchRequest extends DirectorRequestBase {
  req_type: "sketch";
}

export interface BackgroundRemovalRequest extends DirectorRequestBase {
  req_type: "bg-removal";
}

export interface DeclutterRequest extends DirectorRequestBase {
  req_type: "declutter";
}

export interface ColorizeRequest extends DirectorRequestBase {
  req_type: "colorize";
  prompt: string;
  defry: number;
}

export interface EmotionRequest extends DirectorRequestBase {
  req_type: "emotion";
  prompt: string;
  defry: number;
}

export type DirectorRequest =
  | LineArtRequest
  | SketchRequest
  | BackgroundRemovalRequest
  | DeclutterRequest
  | ColorizeRequest
  | EmotionRequest;

export interface NovelAIOptions {
  token: string;
  /** Host used for image endpoints (default: Host.IMAGE) */
  host?: Host | string;
  /** Host used for text generation endpoints (default: Host.TEXT) */
  textHost?: Host | string;
  /**
   * Request timeout in milliseconds. Covers the time until the API responds
   * (for image generation that includes the generation itself).
   * @default 120000
   */
  timeout?: number;
  retry?: RetryConfig;
  verbose?: boolean;
}

// API response types
export interface NovelAIResponse {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  data: ArrayBuffer | ReadableStream<Uint8Array> | null;
}

/** Options for `generateImage`. */
export interface GenerateImageOptions {
  /** Stream intermediate denoising steps (V4/V5 only). */
  stream?: boolean;
  /** Requested stream framing. Defaults to SSE per the official docs. */
  streamFormat?: StreamingType;
  /** Non-stream response encoding. Defaults to ZIP. */
  format?: "zip" | "json";
  /** Whether the user has Opus (cost-estimate logging only). */
  isOpus?: boolean;
}

/** Options for `upscale`. */
export interface UpscaleOptions {
  /** Existing image model API name. */
  model?: Model | string;
  /** Must be one of 0, 0.30, 0.35, 0.40, 0.45, 0.50. */
  declaredBlurSigma?: DeclaredBlurSigma;
}

/** Options for `encodeVibe`. */
export interface EncodeVibeOptions {
  model?: Model | string;
  /** 0-1, defaults to 1. */
  informationExtracted?: number;
  /** Optional mask. */
  mask?: ImageInput;
  /** Crop the image to the visible mask area. */
  cropToMask?: boolean;
  focusSeed?: number;
  infoExtractSeed?: number;
}

export interface EncodeVibeRequest {
  image: string;
  model: string;
  information_extracted?: number;
  mask?: string;
  crop_to_mask?: boolean;
  focus_seed?: number;
  info_extract_seed?: number;
}

/**
 * Options for the enhance() convenience method — img2img re-generation at a
 * scaled-up resolution, mirroring the web UI's Enhance feature.
 */
export type EnhanceOptions = Omit<
  Metadata,
  "image" | "action" | "width" | "height"
> & {
  /** Target resolution multiplier relative to the source image (default: 1.5) */
  upscaleFactor?: number;
};

// Tag suggestion types
export interface TagSuggestion {
  tag: string;
  confidence?: number;
  count?: number;
}

export interface TagSuggestionResponse {
  tags: TagSuggestion[] | TagSuggestion;
}

// ---- Text generation ----

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional author name (OpenAI-compatible extension). */
  name?: string;
}

/**
 * Options for text generation via the OpenAI-compatible endpoints.
 */
export interface TextGenerationOptions {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  logit_bias?: Record<string, number>;
  n?: number;
  best_of?: number;
  echo?: boolean;
  logprobs?: number;
  suffix?: string;
  user?: string;
  enable_thinking?: boolean;
  generation_prefix?: string;
  unified_cubic?: number;
  unified_linear?: number;
  unified_quadratic?: number;
  unified_increase_linear_with_entropy?: number;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface ChatCompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: Partial<ChatMessage>;
  finish_reason: string | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

export type CompletionPrompt = string | string[] | number[] | number[][];

export interface Completion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: { index: number; text: string; finish_reason: string | null }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface OpenAIModelsResponse {
  object: string;
  data: OpenAIModelInfo[];
}

export interface OAITokenCountResponse {
  encoded: number[];
  length: number;
}

// ---- Native text generation (/ai/generate) ----

export type PhraseRepPen =
  | "off"
  | "very_light"
  | "light"
  | "medium"
  | "aggressive"
  | "very_aggressive";

export interface LogitBiasParameters {
  sequence?: number[];
  bias?: number;
  ensure_sequence_finish: boolean;
  generate_once: boolean;
}

/**
 * Parameters accepted by the native `/ai/generate` endpoints. Unknown fields
 * are passed through, matching the API's permissive parameter object.
 */
export interface NativeTextOptions {
  model?: string;
  max_length?: number;
  min_length?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  typical_p?: number;
  tail_free_sampling?: number;
  repetition_penalty?: number;
  repetition_penalty_range?: number;
  repetition_penalty_slope?: number;
  repetition_penalty_frequency?: number;
  repetition_penalty_presence?: number;
  repetition_penalty_whitelist?: number[];
  phrase_rep_pen?: PhraseRepPen;
  stop_sequences?: number[][];
  bad_words_ids?: number[][];
  logit_bias_exp?: LogitBiasParameters[];
  order?: number[];
  use_string?: boolean;
  num_logprobs?: number;
  mirostat_lr?: number;
  mirostat_tau?: number;
  cfg_scale?: number;
  cfg_uc?: string;
  generate_until_sentence?: boolean;
  bracket_ban?: boolean;
  eos_token_id?: number;
  valid_first_tokens?: number[];
  n_samples?: number;
  prefix?: string;
  [key: string]: unknown;
}

export interface LMGenerateRequest {
  input: string;
  model: string;
  parameters: Record<string, unknown>;
  n_samples?: number;
  prefix?: string;
}

export interface LMLogprobs {
  before?: number[][][];
  after?: number[][][];
  chosen?: number[][][];
}

export interface LMGenerationResponse {
  output: string;
  logprobs?: LMLogprobs[];
}

// ---- Voice generation ----

export interface GenerateVoiceOptions {
  text: string;
  /** Voice id, or -1 to derive the voice from `seed`. */
  voice: number;
  /** Required when `voice` is -1. */
  seed?: string;
  /** true returns audio/webm (opus); false returns audio/mpeg. */
  opus?: boolean;
  /** TTS model version: v1 or v2. */
  version?: string;
}

export interface VoiceResult {
  data: Uint8Array;
  mimeType: "audio/webm" | "audio/mpeg";
}
