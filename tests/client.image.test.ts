import { afterEach, describe, expect, it } from "vitest";
import { encode } from "@msgpack/msgpack";
import { NovelAI } from "../src/client";
import {
  ImageFormat,
  Model,
  StreamingType,
} from "../src/constants";
import { EventType } from "../src/image";
import { NovelAIStreamError } from "../src/utils";
import {
  binaryResponse,
  installFetchMock,
  restoreFetch,
  jsonResponse,
  msgpackResponse,
  sseResponse,
  zipResponse,
} from "./helpers/fetch";

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3fWQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const PNG_B64 = Buffer.from(PNG).toString("base64");

function msgpackFrame(obj: unknown): Uint8Array {
  const body = encode(obj);
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, 4);
  return frame;
}

function finalSseEvent(): string {
  return `data: ${JSON.stringify({
    event_type: "final",
    samp_ix: 0,
    step_ix: 27,
    gen_id: "gen-1",
    sigma: 0,
    image: PNG_B64,
  })}\n\n`;
}

afterEach(restoreFetch);

describe("generateImage", () => {
  it("posts a ZIP request to /ai/generate-image", async () => {
    const { calls } = installFetchMock(async () =>
      zipResponse({ "image.png": PNG }),
    );
    const client = new NovelAI({ token: "test" });

    const images = await client.generateImage({
      prompt: "1girl",
      model: Model.V4_5,
    });

    expect(images).toHaveLength(1);
    expect(images[0].data).toEqual(PNG);
    expect(calls[0].url).toBe("https://image.novelai.net/ai/generate-image");
    expect(calls[0].init.headers).toMatchObject({
      Accept: "application/zip",
    });
    expect(calls[0].body.input).toContain("1girl");
    expect(calls[0].body.parameters.stream).toBeUndefined();
    expect(calls[0].body.parameters.v4_prompt).toBeDefined();
  });

  it("supports the JSON response mode with seed/index", async () => {
    const { calls } = installFetchMock(() =>
      jsonResponse({
        images: [{ image: PNG_B64, index: 0, seed: 12345 }],
      }),
    );
    const client = new NovelAI({ token: "test" });

    const images = await client.generateImage(
      { prompt: "1girl", model: Model.V5, image_format: ImageFormat.WEBP },
      { format: "json" },
    );

    expect(calls[0].init.headers).toMatchObject({
      Accept: "application/json",
    });
    expect(images[0].seed).toBe(12345);
    expect(images[0].index).toBe(0);
    expect(calls[0].body.parameters.qualityToggle).toBeUndefined();
  });

  it("streams SSE events by default", async () => {
    const { calls } = installFetchMock(() => sseResponse(finalSseEvent()));
    const client = new NovelAI({ token: "test" });

    const stream = await client.generateImage(
      { prompt: "1girl", model: Model.V4_5 },
      { stream: true },
    );
    const events = [];
    for await (const event of stream) events.push(event);

    expect(calls[0].url).toBe(
      "https://image.novelai.net/ai/generate-image-stream",
    );
    expect(calls[0].init.headers).toMatchObject({
      Accept: "text/event-stream",
    });
    expect(calls[0].body.parameters.stream).toBe("sse");
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe(EventType.FINAL);
    expect(events[0].image.data).toEqual(PNG);
  });

  it("streams msgpack when requested", async () => {
    const { calls } = installFetchMock(() =>
      msgpackResponse(
        msgpackFrame({
          event_type: "final",
          samp_ix: 0,
          step_ix: 27,
          gen_id: "gen-2",
          sigma: 0,
          image: PNG,
        }),
      ),
    );
    const client = new NovelAI({ token: "test" });

    const stream = await client.generateImage(
      { prompt: "1girl", model: Model.V4_5 },
      { stream: true, streamFormat: StreamingType.MSGPACK },
    );
    const events = [];
    for await (const event of stream) events.push(event);

    expect(calls[0].init.headers).toMatchObject({
      Accept: "application/octet-stream",
    });
    expect(calls[0].body.parameters.stream).toBe("msgpack");
    expect(events[0].event_type).toBe(EventType.FINAL);
  });

  it("buffers a ZIP returned by the stream endpoint", async () => {
    installFetchMock(async () => zipResponse({ "image.png": PNG }));
    const client = new NovelAI({ token: "test" });

    const stream = await client.generateImage(
      { prompt: "1girl", model: Model.V4_5 },
      { stream: true },
    );
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe(EventType.FINAL);
    expect(events[0].image.data).toEqual(PNG);
  });

  it("throws on stream error events", async () => {
    installFetchMock(() =>
      sseResponse(
        `data: ${JSON.stringify({
          event_type: "error",
          gen_id: "err-1",
          message: "generation failed",
        })}\n\n`,
      ),
    );
    const client = new NovelAI({ token: "test" });
    const stream = await client.generateImage(
      { prompt: "1girl", model: Model.V4_5 },
      { stream: true },
    );

    await expect(
      (async () => {
        for await (const _ of stream) {
          // consume
        }
      })(),
    ).rejects.toBeInstanceOf(NovelAIStreamError);
  });

  it("throws when a stream has no final event", async () => {
    installFetchMock(() =>
      sseResponse(
        `data: ${JSON.stringify({
          event_type: "intermediate",
          samp_ix: 0,
          step_ix: 1,
          gen_id: "gen-3",
          sigma: 0.5,
          image: PNG_B64,
        })}\n\n`,
      ),
    );
    const client = new NovelAI({ token: "test" });
    const stream = await client.generateImage(
      { prompt: "1girl", model: Model.V4_5 },
      { stream: true },
    );

    await expect(
      (async () => {
        for await (const _ of stream) {
          // consume
        }
      })(),
    ).rejects.toBeInstanceOf(NovelAIStreamError);
  });

  it("rejects streaming for V3", async () => {
    const client = new NovelAI({ token: "test" });
    await expect(
      client.generateImage(
        { prompt: "1girl", model: Model.V3 },
        { stream: true },
      ),
    ).rejects.toThrow(/V4\/V5/);
  });
});

describe("upscale", () => {
  it("uses the documented request body and image host", async () => {
    const { calls } = installFetchMock(async () =>
      zipResponse({ "upscaled.png": PNG }),
    );
    const client = new NovelAI({ token: "test" });

    const image = await client.upscale(PNG_B64, {
      model: Model.V4_5,
      declaredBlurSigma: 0.3,
    });

    expect(image.data).toEqual(PNG);
    expect(calls[0].url).toBe("https://image.novelai.net/ai/upscale");
    expect(calls[0].body).toEqual({
      image: PNG_B64,
      model: Model.V4_5,
      declared_blur_sigma: 0.3,
    });
  });

  it("rejects unsupported blur sigma values", async () => {
    const client = new NovelAI({ token: "test" });
    await expect(
      client.upscale(PNG_B64, { declaredBlurSigma: 0.2 as any }),
    ).rejects.toThrow(/declaredBlurSigma/);
  });
});

describe("encodeVibe / suggestTags", () => {
  it("sends all encode-vibe options", async () => {
    const { calls } = installFetchMock(() =>
      binaryResponse(new Uint8Array([1, 2, 3])),
    );
    const client = new NovelAI({ token: "test" });

    const token = await client.encodeVibe(PNG_B64, {
      model: Model.V4_5,
      informationExtracted: 0.8,
      mask: PNG_B64,
      cropToMask: true,
      focusSeed: 11,
      infoExtractSeed: 22,
    });

    expect(token).toBe("AQID");
    expect(calls[0].url).toBe("https://image.novelai.net/ai/encode-vibe");
    expect(calls[0].body).toMatchObject({
      image: PNG_B64,
      model: Model.V4_5,
      information_extracted: 0.8,
      mask: PNG_B64,
      crop_to_mask: true,
      focus_seed: 11,
      info_extract_seed: 22,
    });
  });

  it("normalizes array and single-object tag responses", async () => {
    const client = new NovelAI({ token: "test" });

    installFetchMock(() =>
      jsonResponse({ tags: [{ tag: "1girl", confidence: 0.9 }] }),
    );
    await expect(client.suggestTags("1gi")).resolves.toHaveLength(1);
    restoreFetch();

    installFetchMock(() => jsonResponse({ tags: { tag: "1girl" } }));
    await expect(client.suggestTags("1gi")).resolves.toEqual([
      { tag: "1girl" },
    ]);
  });
});
