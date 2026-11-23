import { RetryConfig } from "../types";
import {
  apiErrorFromResponse,
  generateXCorrelationId,
  prepHeaders,
} from "./http-utils";
import { withRetry } from "./retry-utils";

export interface TransportConfig {
  headers: Record<string, string>;
  timeout: number;
  retry?: RetryConfig;
  verbose?: boolean;
}

export type TransportMethod = "GET" | "POST";

export interface TransportRequestOptions {
  method?: TransportMethod;
  body?: unknown;
  accept?: string;
  timeout?: number;
  /** Pass `false` to disable retries for this request. */
  retry?: RetryConfig | false;
  /** Non-idempotent requests disable network/timeout retries. */
  idempotent?: boolean;
  signal?: AbortSignal;
}

export interface TransportBufferResult {
  data: Uint8Array;
  contentType: string;
  headers: Record<string, string>;
  correlationId: string;
}

export interface TransportStreamResult {
  response: Response;
  correlationId: string;
}

/**
 * Small HTTP transport shared by every endpoint. It owns the stable
 * correlation ID, timeout, retry policy and API error parsing.
 */
export class NovelAITransport {
  constructor(private readonly config: TransportConfig) {}

  async json<T>(
    url: string,
    options: TransportRequestOptions = {},
  ): Promise<T> {
    const { response } = await this.execute(url, options);
    return (await response.json()) as T;
  }

  async buffer(
    url: string,
    options: TransportRequestOptions = {},
  ): Promise<TransportBufferResult> {
    const { response, correlationId } = await this.execute(url, options);
    const data = new Uint8Array(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      data,
      contentType: response.headers.get("content-type") || "",
      headers,
      correlationId,
    };
  }

  async stream(
    url: string,
    options: TransportRequestOptions = {},
  ): Promise<TransportStreamResult> {
    const { response, correlationId } = await this.execute(url, options);
    if (!response.body) {
      throw new Error("No response body available for streaming");
    }
    return { response, correlationId };
  }

  private async execute(
    url: string,
    options: TransportRequestOptions,
  ): Promise<{ response: Response; correlationId: string }> {
    const correlationId = generateXCorrelationId();
    const retryConfig = this.resolveRetry(options);

    if (this.config.verbose) {
      console.debug(
        `[Request] ${options.method || (options.body ? "POST" : "GET")} ${url}`,
      );
    }

    const response = await withRetry(async () => {
      const controller = new AbortController();
      const timeout = options.timeout ?? this.config.timeout;
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const headers = prepHeaders(this.config.headers, correlationId);
      if (options.accept) headers.Accept = options.accept;

      const init: RequestInit = {
        method: options.method || (options.body === undefined ? "GET" : "POST"),
        headers,
        signal: combineSignals(controller.signal, options.signal),
      };

      if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      } else {
        delete headers["Content-Type"];
      }

      try {
        const result = await fetch(url, init);
        if (!result.ok) {
          throw await apiErrorFromResponse(result, correlationId);
        }
        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    }, retryConfig);

    return { response, correlationId };
  }

  private resolveRetry(
    options: TransportRequestOptions,
  ): RetryConfig | undefined {
    if (options.retry === false) {
      return { enabled: false };
    }

    const base = {
      ...(this.config.retry || {}),
      ...(options.retry || {}),
    };

    if (options.idempotent === false) {
      base.retryNetworkErrors = false;
      base.retryOnTimeout = false;
    }

    return base;
  }
}

function combineSignals(
  timeoutSignal: AbortSignal,
  callerSignal?: AbortSignal,
): AbortSignal {
  if (!callerSignal) return timeoutSignal;
  const anySignal = (AbortSignal as any).any;
  if (typeof anySignal === "function") {
    return anySignal([timeoutSignal, callerSignal]);
  }
  return timeoutSignal;
}
