import { afterEach, describe, expect, it } from "vitest";
import { NovelAI } from "../src/client";
import { TextModel } from "../src/constants";
import {
  binaryResponse,
  installFetchMock,
  restoreFetch,
  jsonResponse,
  sseResponse,
} from "./helpers/fetch";

afterEach(restoreFetch);

describe("native text", () => {
  it("builds a native /ai/generate payload with required defaults", async () => {
    const { calls } = installFetchMock(() => jsonResponse({ output: "hi" }));
    const client = new NovelAI({ token: "test" });

    const result = await client.generateText("Once upon a time", {
      model: TextModel.ERATO,
      temperature: 0.8,
    });

    expect(result.output).toBe("hi");
    expect(calls[0].url).toBe("https://text.novelai.net/ai/generate");
    expect(calls[0].body).toMatchObject({
      input: "Once upon a time",
      model: TextModel.ERATO,
      parameters: {
        temperature: 0.8,
        max_length: 100,
        use_string: true,
        logit_bias_exp: [],
      },
    });
  });

  it("rejects an invalid max_length before sending", async () => {
    const { calls } = installFetchMock(() => jsonResponse({ output: "" }));
    const client = new NovelAI({ token: "test" });

    await expect(
      client.generateText("x", { max_length: 2049 }),
    ).rejects.toThrow(/max_length/);
    expect(calls).toHaveLength(0);
  });

  it("streams native text tokens in order", async () => {
    installFetchMock(() =>
      sseResponse(
        'data: {"token":"Hello"}\n\ndata: {"token":", world"}\n\ndata: [DONE]\n\n',
      ),
    );
    const client = new NovelAI({ token: "test" });
    const stream = await client.generateTextStream("hi");
    let output = "";
    for await (const token of stream) output += token;
    expect(output).toBe("Hello, world");
  });
});

describe("OpenAI-compatible text", () => {
  it("calls chat non-streaming and preserves OpenAI fields", async () => {
    const { calls } = installFetchMock(() =>
      jsonResponse({
        id: "chat-1",
        object: "chat.completion",
        created: 1,
        model: TextModel.GLM_4_6,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const client = new NovelAI({ token: "test" });

    const result = await client.chat("hi", { enable_thinking: false });

    expect(result.choices[0].message.content).toBe("hello");
    expect(calls[0].url).toBe(
      "https://text.novelai.net/oa/v1/chat/completions",
    );
    expect(calls[0].body).toMatchObject({
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      enable_thinking: false,
    });
  });

  it("passes prompt arrays to completions unchanged", async () => {
    const { calls } = installFetchMock(() =>
      jsonResponse({
        id: "cmpl-1",
        object: "text_completion",
        created: 1,
        model: TextModel.GLM_4_6,
        choices: [{ index: 0, text: "x", finish_reason: "stop" }],
      }),
    );
    const client = new NovelAI({ token: "test" });

    await client.completion(["a", "b"]);
    expect(calls[0].body.prompt).toEqual(["a", "b"]);
    expect(calls[0].body.stream).toBe(false);
  });

  it("returns full model objects from /oa/v1/models", async () => {
    installFetchMock(() =>
      jsonResponse({
        object: "list",
        data: [
          {
            id: TextModel.ERATO,
            object: "model",
            created: 1,
            owned_by: "novelai",
          },
        ],
      }),
    );
    const client = new NovelAI({ token: "test" });
    const models = await client.listTextModels();
    expect(models[0]).toMatchObject({
      id: TextModel.ERATO,
      owned_by: "novelai",
    });
  });

  it("counts tokens through the extension endpoint", async () => {
    const { calls } = installFetchMock(() =>
      jsonResponse({ encoded: [1, 2, 3], length: 3 }),
    );
    const client = new NovelAI({ token: "test" });
    const result = await client.countTokens("hello");
    expect(result.length).toBe(3);
    expect(calls[0].url).toBe(
      "https://text.novelai.net/oa/v1/internal/token-count",
    );
    expect(calls[0].body.prompt).toBe("hello");
  });
});

describe("voice", () => {
  it("returns audio data and mime type", async () => {
    installFetchMock(() =>
      binaryResponse(new Uint8Array([1, 2, 3]), "audio/webm"),
    );
    const client = new NovelAI({ token: "test" });
    const result = await client.generateVoice({
      text: "hello",
      voice: 1,
    });
    expect(result.mimeType).toBe("audio/webm");
    expect(result.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("requires a seed when voice is -1", async () => {
    const client = new NovelAI({ token: "test" });
    await expect(
      client.generateVoice({ text: "hello", voice: -1 }),
    ).rejects.toThrow(/seed/);
  });
});
