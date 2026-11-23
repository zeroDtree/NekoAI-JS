import { afterEach, describe, expect, it } from "vitest";
import { NovelAITransport } from "../src/utils/transport";
import { NovelAIApiError } from "../src/utils";
import { installFetchMock, jsonResponse, restoreFetch } from "./helpers/fetch";

afterEach(restoreFetch);

function transport(): NovelAITransport {
  return new NovelAITransport({
    headers: { Authorization: "Bearer test" },
    timeout: 1000,
    retry: { baseDelay: 1, maxDelay: 1, maxRetries: 2 },
  });
}

describe("NovelAITransport", () => {
  it("does not retry 429 by default", async () => {
    const { calls } = installFetchMock(() =>
      jsonResponse({ message: "rate limited" }, 429),
    );

    await expect(
      transport().json("https://example.test/x", { method: "GET" }),
    ).rejects.toBeInstanceOf(NovelAIApiError);
    expect(calls).toHaveLength(1);
  });

  it("retries gateway failures with a stable correlation ID", async () => {
    let attempt = 0;
    const { calls } = installFetchMock(() => {
      attempt++;
      return attempt === 1
        ? jsonResponse({ message: "bad gateway" }, 502)
        : jsonResponse({ ok: true });
    });

    const result = await transport().json<{ ok: boolean }>(
      "https://example.test/x",
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const headers = calls[0].init.headers as Record<string, string>;
    const secondHeaders = calls[1].init.headers as Record<string, string>;
    expect(headers["x-correlation-id"]).toBe(
      secondHeaders["x-correlation-id"],
    );
  });

  it("does not retry network errors for non-idempotent requests", async () => {
    let attempts = 0;
    installFetchMock(() => {
      attempts++;
      throw new TypeError("fetch failed");
    });

    await expect(
      transport().json("https://example.test/x", { idempotent: false }),
    ).rejects.toThrow(/fetch failed/);
    expect(attempts).toBe(1);
  });

  it("captures details, body statusCode and correlation ID", async () => {
    installFetchMock(() =>
      jsonResponse(
        {
          message: "not enough anlas",
          statusCode: 402,
          details: { required: 20 },
        },
        402,
        { "x-correlation-id": "CORR01" },
      ),
    );

    try {
      await transport().json("https://example.test/x");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NovelAIApiError);
      const apiError = error as NovelAIApiError;
      expect(apiError.statusCode).toBe(402);
      expect(apiError.details).toEqual({ required: 20 });
      expect(apiError.correlationId).toBe("CORR01");
    }
  });
});
