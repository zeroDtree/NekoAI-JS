const { NovelAI, Model, StreamingType, EventType } = require("nekoai-js");
require("dotenv").config();

async function main() {
  const client = new NovelAI({ token: process.env.NOVELAI_TOKEN });
  const stream = await client.generateImage(
    { prompt: "1girl, night sky", model: Model.V4_5 },
    { stream: true, streamFormat: StreamingType.SSE },
  );

  for await (const event of stream) {
    if (event.event_type === EventType.INTERMEDIATE) {
      console.log(`step ${event.step_ix}`);
    } else if (event.event_type === EventType.FINAL) {
      await event.image.save("./examples/output/stream-final.png");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
