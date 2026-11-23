// Export main client
export { NovelAI } from "./client";

// Export image class
export { Image, MsgpackEvent, EventType } from "./image";

// Export constants
export {
  Action,
  Controlnet,
  DirectorTools,
  EmotionLevel,
  EmotionOptions,
  Host,
  ImageFormat,
  Model,
  Noise,
  Resolution,
  RESOLUTION_DIMENSIONS,
  Sampler,
  StreamingType,
  TextModel,
  getImageModelFamily,
  isV4Model,
  isV5Model,
  isV5MediumModel,
} from "./constants";

// Export all public types
export type * from "./types";

// Export utilities
export {
  NovelAIApiError,
  NovelAIStreamError,
  SSEStream,
  StreamingMsgpackParser,
  StreamingSSEParser,
  NovelAITransport,
  buildImagePayload,
  projectParameters,
  calculateCost,
  createFilename,
  DEFAULT_RETRY_CONFIG,
  decodeBufferedImageResponse,
  decodeImageStream,
  deduplicateTags,
  detectImageFormat,
  ensureDirectoryExists,
  formatFileSize,
  imageExtension,
  parseImage,
  parseStreamEvents,
  scaleDimensions,
  MAX_PIXELS,
  saveBinaryFile,
  base64ToUint8Array,
  uint8ArrayToBase64,
  withRetry,
  extractImageMetadata,
  getImageSummary,
} from "./utils";
