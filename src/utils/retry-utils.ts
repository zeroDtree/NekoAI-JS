import { RetryConfig } from "../types";

// Default retry configuration.
// 429 is intentionally absent: the API docs state that rate-limited requests
// must not be retried, and a retried generation may be billed twice.
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  enabled: true,
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  retryStatusCodes: [500, 502, 503, 504],
  retryOnTimeout: false,
  retryNetworkErrors: true,
};

/**
 * Execute a function with retry logic.
 *
 * @param fn - Async function to execute with retry logic
 * @param retryConfig - Configuration for retry behavior
 * @returns Promise that resolves with the result of the function
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retryConfig?: RetryConfig,
): Promise<T> {
  const config: Required<RetryConfig> = {
    ...DEFAULT_RETRY_CONFIG,
    ...(retryConfig || {}),
  };

  if (!config.enabled) {
    return fn();
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (!shouldRetryRequest(error, config, attempt)) {
        throw error;
      }

      const delay = calculateRetryDelay(attempt, config);

      console.warn(
        `Request failed with error: ${lastError.message}. Retrying in ${delay}ms... (Attempt ${attempt + 1}/${config.maxRetries})`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error("Failed after retries");
}

/**
 * Determine if a request should be retried based on the error and config.
 */
function shouldRetryRequest(
  error: any,
  config: Required<RetryConfig>,
  attempt: number,
): boolean {
  if (attempt >= config.maxRetries) {
    return false;
  }

  if (error && error.status && config.retryStatusCodes.includes(error.status)) {
    return true;
  }

  // Network errors are only safe to retry on idempotent requests.
  if (
    config.retryNetworkErrors &&
    error instanceof TypeError &&
    error.message.includes("fetch")
  ) {
    return true;
  }

  // Timeouts/aborts are never retried unless explicitly enabled.
  if (config.retryOnTimeout && error?.name === "AbortError") {
    return true;
  }

  return false;
}

/**
 * Calculate retry delay with true exponential backoff and jitter.
 */
function calculateRetryDelay(
  attempt: number,
  config: Required<RetryConfig>,
): number {
  const exponentialDelay = config.baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 300;
  return Math.min(exponentialDelay + jitter, config.maxDelay);
}
