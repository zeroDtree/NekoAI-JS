import { decode } from "@msgpack/msgpack";
import JSZip from "jszip";
import { NovelAIResponse } from "../types";
import { Image, MsgpackEvent, EventType } from "../image";
import { base64ToUint8Array } from "./image-utils";
import { timestampString } from "./fs-utils";

/**
 * Error thrown for non-2xx API responses. Carries the HTTP status, the API's
 * structured error details and the correlation ID used for reporting.
 */
export class NovelAIApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  /** `statusCode` from the API error body, when present. */
  readonly statusCode?: number;
  /** `details` from the API error body, when present. */
  readonly details?: unknown;
  /** Correlation ID for the logical request (also returned by the API). */
  readonly correlationId?: string;

  constructor(
    status: number,
    statusText: string,
    options?: string | {
      message?: string;
      details?: unknown;
      statusCode?: number;
      correlationId?: string;
    },
  ) {
    const resolved =
      typeof options === "string" ? { message: options } : options || {};
    super(
      resolved.message
        ? `NovelAI API error ${status}: ${resolved.message}`
        : `NovelAI API error ${status} ${statusText}`,
    );
    this.name = "NovelAIApiError";
    this.status = status;
    this.statusText = statusText;
    this.details = resolved.details;
    this.statusCode = resolved.statusCode;
    this.correlationId = resolved.correlationId;
  }

  /** Whether the status is one that the default retry policy retries. */
  get retryable(): boolean {
    return this.status === 500 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

/** Error thrown when an image/text stream reports an error event. */
export class NovelAIStreamError extends Error {
  /** Raw event object returned by the stream. */
  readonly event?: unknown;
  readonly genId?: string;

  constructor(
    message: string,
    options?: { event?: unknown; genId?: string },
  ) {
    super(message);
    this.name = "NovelAIStreamError";
    this.event = options?.event;
    this.genId = options?.genId;
  }
}

/**
 * A single parsed Server-Sent Event
 */
export interface SSEEvent {
  event?: string;
  data: string;
}

/**
 * Minimal incremental Server-Sent Events parser.
 */
export class SSEStream {
  private buffer = "";
  private decoder = new TextDecoder();

  *feed(chunk: Uint8Array): Generator<SSEEvent, void, unknown> {
    this.buffer += this.decoder.decode(chunk, { stream: true });

    const rawEvents = this.buffer.split("\n\n");
    this.buffer = rawEvents.pop() || "";

    for (const raw of rawEvents) {
      const event = parseSSEEventText(raw);
      if (event) yield event;
    }
  }

  *flush(): Generator<SSEEvent, void, unknown> {
    const event = parseSSEEventText(this.buffer);
    this.buffer = "";
    if (event) yield event;
  }
}

function parseSSEEventText(raw: string): SSEEvent | null {
  if (!raw.trim()) return null;

  let eventName: string | undefined;
  let data = "";

  for (const line of raw.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    const field = line.substring(0, colonIndex).trim();
    const value = line.substring(colonIndex + 1).trim();
    if (field === "data") {
      data += (data ? "\n" : "") + value;
    } else if (field === "event") {
      eventName = value;
    }
  }

  if (!data) return null;
  return { event: eventName, data };
}

/**
 * Real-time msgpack parser for NovelAI's length-prefixed event stream.
 */
export class StreamingMsgpackParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private expectedMessageLength: number | null = null;

  *feedChunk(chunk: Uint8Array): Generator<MsgpackEvent, void, unknown> {
    const newBuffer = new Uint8Array(this.buffer.length + chunk.length);
    newBuffer.set(this.buffer);
    newBuffer.set(chunk, this.buffer.length);
    this.buffer = newBuffer;

    while (true) {
      if (this.expectedMessageLength === null) {
        if (this.buffer.length < 4) break;

        this.expectedMessageLength = new DataView(
          this.buffer.buffer,
          this.buffer.byteOffset,
          4,
        ).getUint32(0, false);
        this.buffer = this.buffer.slice(4);
      }

      if (this.buffer.length < this.expectedMessageLength) break;

      const messageData = this.buffer.slice(0, this.expectedMessageLength);
      this.buffer = this.buffer.slice(this.expectedMessageLength);
      this.expectedMessageLength = null;

      const event = parseMsgpackMessage(messageData);
      if (event) yield event;
    }
  }
}

/**
 * Real-time parser for the SSE flavor of NovelAI's event stream.
 */
export class StreamingSSEParser {
  private sse = new SSEStream();

  *feedChunk(chunk: Uint8Array): Generator<MsgpackEvent, void, unknown> {
    for (const event of this.sse.feed(chunk)) {
      const parsed = parseEventJson(event.data);
      if (parsed) yield parsed;
    }
  }

  *flush(): Generator<MsgpackEvent, void, unknown> {
    for (const event of this.sse.flush()) {
      const parsed = parseEventJson(event.data);
      if (parsed) yield parsed;
    }
  }
}

function parseEventJson(data: string): MsgpackEvent | null {
  try {
    const obj = JSON.parse(data);
    if (obj && typeof obj === "object" && "event_type" in obj) {
      return createMsgpackEvent(obj);
    }
  } catch (error) {
    if (error instanceof NovelAIStreamError) throw error;
    console.warn("Failed to parse SSE event data:", error);
  }
  return null;
}

/**
 * Parse a complete SSE buffer into individual events.
 */
export function parseSSEEvents(sseData: Uint8Array): MsgpackEvent[] {
  const parser = new StreamingSSEParser();
  return [...parser.feedChunk(sseData), ...parser.flush()];
}

/**
 * Parse a complete length-prefixed msgpack buffer into individual events.
 */
export function parseMsgpackEvents(msgpackData: Uint8Array): MsgpackEvent[] {
  const parser = new StreamingMsgpackParser();
  return [...parser.feedChunk(msgpackData)];
}

/**
 * Auto-detect msgpack vs SSE and parse buffered stream data.
 */
export function parseStreamEvents(streamData: Uint8Array): MsgpackEvent[] {
  const format = detectImageFormat(streamData);
  if (format === "sse") return parseSSEEvents(streamData);
  return parseMsgpackEvents(streamData);
}

/**
 * Parse a single msgpack message and return the event.
 */
export function parseMsgpackMessage(
  messageData: Uint8Array,
): MsgpackEvent | null {
  try {
    const obj = decode(messageData) as any;
    if (typeof obj === "object" && obj !== null && "event_type" in obj) {
      return createMsgpackEvent(obj);
    }
  } catch (error) {
    if (error instanceof NovelAIStreamError) throw error;
    try {
      const text = new TextDecoder().decode(messageData);
      if (text.trim().startsWith("{")) {
        const obj = JSON.parse(text);
        if (typeof obj === "object" && obj !== null && "event_type" in obj) {
          return createMsgpackEvent(obj);
        }
      }
    } catch (innerError) {
      if (innerError instanceof NovelAIStreamError) throw innerError;
      // Not a msgpack frame and not JSON; ignore.
    }
  }
  return null;
}

/**
 * Create a MsgpackEvent from a parsed stream event object.
 * Throws NovelAIStreamError for error events and skips retry notices.
 */
export function createMsgpackEvent(obj: any): MsgpackEvent | null {
  const eventType = String(obj.event_type || "");

  if (eventType === "error") {
    throw new NovelAIStreamError(
      String(obj.message || obj.error || "NovelAI stream error"),
      { event: obj, genId: obj.gen_id ? String(obj.gen_id) : undefined },
    );
  }

  if (eventType === "retry") {
    console.warn("NovelAI stream requested a retry:", obj.message || obj);
    return null;
  }

  let imageData: Uint8Array;

  if (obj.image instanceof Uint8Array) {
    imageData = obj.image;
  } else if (typeof obj.image === "string") {
    try {
      imageData = base64ToUint8Array(obj.image);
    } catch (error) {
      console.warn("Failed to decode base64 image data:", error);
      imageData = new Uint8Array(0);
    }
  } else if (Array.isArray(obj.image)) {
    imageData = new Uint8Array(obj.image);
  } else {
    imageData = new Uint8Array(0);
  }

  if (imageData.length === 0) {
    throw new NovelAIStreamError("Stream event is missing image data", {
      event: obj,
      genId: obj.gen_id ? String(obj.gen_id) : undefined,
    });
  }

  const sampIx = Number(obj.samp_ix ?? 0);
  const stepIx = Number(obj.step_ix ?? 0);
  const extension = imageExtension(imageData);
  const timestamp = timestampString();
  const filename =
    eventType === "final"
      ? `${timestamp}_p${sampIx}_final.${extension}`
      : `${timestamp}_p${sampIx}_step_${String(stepIx).padStart(2, "0")}.${extension}`;

  return new MsgpackEvent({
    event_type:
      eventType === "final" ? EventType.FINAL : EventType.INTERMEDIATE,
    samp_ix: sampIx,
    step_ix: stepIx,
    gen_id: String(obj.gen_id || ""),
    sigma: Number(obj.sigma ?? 0),
    image: new Image({ filename, data: imageData, index: sampIx }),
  });
}

/** Detect the image container from magic bytes. */
export function imageExtension(data: Uint8Array): "png" | "jpg" | "webp" {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return "jpg";
  if (
    data.length >= 12 &&
    new TextDecoder().decode(data.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(data.slice(8, 12)) === "WEBP"
  ) {
    return "webp";
  }
  return "png";
}

export type ImageStreamFormat = "zip" | "msgpack" | "sse" | "json";

/**
 * Detect the actual image response format from Content-Type and magic bytes.
 */
export function detectImageFormat(
  head: Uint8Array,
  contentType?: string,
): ImageStreamFormat {
  // Magic bytes win over a wrong/ambiguous Content-Type.
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    (head[2] === 0x03 || head[2] === 0x05) &&
    (head[3] === 0x04 || head[3] === 0x06)
  ) {
    return "zip";
  }

  const type = (contentType || "").toLowerCase();
  if (type.includes("application/json")) return "json";
  if (type.includes("application/zip") || type.includes("application/x-zip")) {
    return "zip";
  }
  if (type.includes("text/event-stream")) return "sse";

  const text = new TextDecoder().decode(head.slice(0, 64)).trimStart();
  if (text.startsWith("event:") || text.startsWith("data:")) return "sse";
  if (text.startsWith("{")) return "json";
  return "msgpack";
}

function imagesFromJson(payload: any): Image[] {
  const images = payload?.images;
  if (!Array.isArray(images)) {
    throw new NovelAIStreamError("JSON image response is missing 'images'");
  }
  return images.map(
    (entry: any, position: number) => {
      const data = base64ToUint8Array(entry.image);
      return new Image({
        filename: `${timestampString()}_p${entry.index ?? position}.${imageExtension(data)}`,
        data,
        seed: typeof entry.seed === "number" ? entry.seed : undefined,
        index: typeof entry.index === "number" ? entry.index : position,
      });
    },
  );
}

async function unzipImages(data: Uint8Array | ArrayBuffer): Promise<Image[]> {
  const zip = await JSZip.loadAsync(data);
  const images: Image[] = [];

  for (const filename of Object.keys(zip.files)) {
    const entry = zip.files[filename];
    if (entry.dir) continue;
    const bytes = await entry.async("uint8array");
    const extension = /\.(png|jpe?g|webp)$/i.exec(filename)?.[1]?.toLowerCase();
    if (!extension) continue;
    const ext = extension === "jpeg" ? "jpg" : extension;
    images.push(
      new Image({
        filename: `${timestampString()}_p${images.length}.${ext}`,
        data: bytes,
        index: images.length,
      }),
    );
  }

  if (images.length === 0) {
    throw new NovelAIStreamError("ZIP image response contained no files");
  }
  return images;
}

function finalImagesFromEvents(events: MsgpackEvent[]): Image[] {
  const finals = events
    .filter((event) => event.event_type === EventType.FINAL)
    .map((event) => event.image);

  if (finals.length === 0) {
    throw new NovelAIStreamError("Stream ended without a final image");
  }
  return finals;
}

/**
 * Decode a buffered image response (ZIP, JSON, msgpack or SSE) into images.
 */
export async function decodeBufferedImageResponse(
  buffer: Uint8Array,
  contentType?: string,
): Promise<Image[]> {
  const format = detectImageFormat(buffer, contentType);

  if (format === "json") {
    return imagesFromJson(JSON.parse(new TextDecoder().decode(buffer)));
  }
  if (format === "zip") {
    return unzipImages(buffer);
  }
  return finalImagesFromEvents(parseStreamEvents(buffer));
}

function syntheticFinalEvent(image: Image): MsgpackEvent {
  return new MsgpackEvent({
    event_type: EventType.FINAL,
    samp_ix: image.index ?? 0,
    step_ix: 0,
    gen_id: "",
    sigma: 0,
    image,
  });
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Decode a streaming image response. ZIP responses are buffered and emitted
 * as synthetic final events; msgpack/SSE frames are decoded incrementally.
 */
export async function* decodeImageStream(
  body: ReadableStream<Uint8Array>,
  contentType?: string,
): AsyncGenerator<MsgpackEvent, void, unknown> {
  const reader = body.getReader();
  const pending: Uint8Array[] = [];
  let parser: StreamingMsgpackParser | StreamingSSEParser | null = null;
  let format: ImageStreamFormat | null = null;
  let sawFinal = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (!format) {
        pending.push(value);
        const head = concatenate(pending);
        if (!contentType && head.length < 4) continue;
        format = detectImageFormat(head.slice(0, 64), contentType);
        if (format === "sse") parser = new StreamingSSEParser();
        else if (format === "msgpack") parser = new StreamingMsgpackParser();

        if (parser) {
          for (const event of parser.feedChunk(head)) {
            if (event.event_type === EventType.FINAL) sawFinal = true;
            yield event;
          }
          pending.length = 0;
        }
        continue;
      }

      if (parser) {
        for (const event of parser.feedChunk(value)) {
          if (event.event_type === EventType.FINAL) sawFinal = true;
          yield event;
        }
      } else {
        pending.push(value);
      }
    }

    if (!format) {
      throw new NovelAIStreamError("Image stream returned no data");
    }

    if (format === "zip" || format === "json") {
      const all = concatenate(pending);
      const images =
        format === "json"
          ? imagesFromJson(JSON.parse(new TextDecoder().decode(all)))
          : await unzipImages(all);
      for (const image of images) yield syntheticFinalEvent(image);
      return;
    }

    if (parser instanceof StreamingSSEParser) {
      for (const event of parser.flush()) {
        if (event.event_type === EventType.FINAL) sawFinal = true;
        yield event;
      }
    }

    if (!sawFinal) {
      throw new NovelAIStreamError("Stream ended without a final image");
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Generates a random correlation ID (6 alphanumeric characters).
 */
export function generateXCorrelationId(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Prepare request headers. Passing a correlationId keeps it stable across
 * retries of the same logical request.
 */
export function prepHeaders(
  headers: Record<string, string>,
  correlationId: string = generateXCorrelationId(),
): Record<string, string> {
  return {
    ...headers,
    "x-correlation-id": correlationId,
    "x-initiated-at": new Date().toISOString(),
  };
}

/**
 * Handle a fetch response and buffer binary payloads.
 */
export async function handleResponse(
  response: Response,
  correlationId?: string,
): Promise<NovelAIResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  if (!response.ok) {
    throw await apiErrorFromResponse(response, correlationId);
  }

  const contentType = response.headers.get("Content-Type") || "";
  const isBinary = [
    "application/zip",
    "application/octet-stream",
    "application/msgpack",
    "application/x-msgpack",
    "application/x-zip-compressed",
    "application/binary",
    "audio/webm",
    "audio/mpeg",
    "image/png",
    "image/webp",
  ].some((type) => contentType.includes(type));

  return {
    statusCode: response.status,
    statusText: response.statusText,
    headers,
    data: isBinary ? await response.arrayBuffer() : response.body,
  };
}

/**
 * Build a NovelAIApiError from a failed response, preserving structured
 * details and the correlation ID.
 */
export async function apiErrorFromResponse(
  response: Response,
  correlationId?: string,
): Promise<NovelAIApiError> {
  const headerCorrelationId =
    response.headers.get("x-correlation-id") || correlationId || undefined;
  let message: string | undefined;
  let details: unknown;
  let statusCode: number | undefined;

  try {
    const text = await response.text();
    if (text) {
      try {
        const body = JSON.parse(text);
        message = body.message || body.error || text.slice(0, 300);
        details = body.details;
        statusCode =
          typeof body.statusCode === "number" ? body.statusCode : undefined;
      } catch {
        message = text.slice(0, 300);
      }
    }
  } catch {
    // Body unavailable; status alone will have to do.
  }

  return new NovelAIApiError(response.status, response.statusText, {
    message,
    details,
    statusCode,
    correlationId: headerCorrelationId,
  });
}
