# NovelAI API Alignment (2.0)

Baseline: official `image.novelai.net/docs/doc.json` (same paths are served by the
text and primary docs). This package intentionally covers the **generation
domain only**; the `/user/*` account domain is out of scope.

## Coverage

| Path | Host | Client method | Status |
| --- | --- | --- | --- |
| `/ai/generate-image` | image | `generateImage(metadata, { format })` | implemented |
| `/ai/generate-image-stream` | image | `generateImage(metadata, { stream: true })` | implemented (ZIP/msgpack/SSE) |
| `/ai/upscale` | image | `upscale(image, options)` | implemented |
| `/ai/augment-image` | image | `lineArt`, `sketch`, `backgroundRemoval`, `declutter`, `colorize`, `changeEmotion` | implemented |
| `/ai/encode-vibe` | image | `encodeVibe(image, options)` | implemented |
| `/ai/generate-image/suggest-tags` | image | `suggestTags(prompt, model?, lang?)` | implemented |
| `/ai/generate` | text | `generateText(prompt, options)` | implemented |
| `/ai/generate-stream` | text | `generateTextStream(prompt, options)` | implemented |
| `/ai/generate-voice` | image | `generateVoice(options)` | implemented |
| `/oa/v1/chat/completions` | text | `chat`, `chatStream` | implemented |
| `/oa/v1/completions` | text | `completion` | implemented |
| `/oa/v1/internal/token-count` | text | `countTokens(prompt, options?)` | implemented |
| `/oa/v1/models` | text | `listTextModels()` | implemented |

Not covered by design: `/user/*` (login, subscription, keystore, user data,
consent), `/ai/annotate-image` (not in the current docs snapshot), and local
tokenizer implementations.

## Upstream ambiguities

1. **Upscale host/body.** The docs specify `image.novelai.net/ai/upscale` with
   `{ image, model, declared_blur_sigma }`. Older community clients used
   `api.novelai.net/ai/upscale` with `{ image, width, height, scale }`. This
   client implements only the documented contract. If the documented endpoint
   is not live for an account, record it as an upstream blocker instead of
   falling back to the legacy body.
2. **`suggest-tags` response shape.** The docs define `tags` as a single object,
   while the live service has returned an array. The client normalizes both.
3. **Stream framing.** The docs describe SSE for
   `/ai/generate-image-stream`, while V4 historically used length-prefixed
   msgpack. The default is SSE, and the decoder sniffs ZIP/msgpack/SSE from the
   response, so both work.

## Verification

Offline:

```sh
bun install
bun run typecheck
bun test
bun run lint
bun run build
```

Live smoke (manual, PAT required, may consume Anlas):

1. V4.5 normal generation, then JSON mode.
2. V4.5 streaming with `streamFormat: "sse"` and `"msgpack"`.
3. V4.5 img2img through the stream endpoint (ZIP branch).
4. `upscale` with the documented contract.
5. `generateText` and `generateTextStream`.
6. `countTokens`.
7. `suggestTags` array/object shape.
8. `generateVoice`.
