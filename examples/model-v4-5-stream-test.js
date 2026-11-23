const { NovelAI, Model, Resolution, Sampler, EventType } = require("nekoai-js");
const fs = require("fs");
require("dotenv").config();

async function testModelV45Streaming() {
  // Use your NAI token (replace with your actual token)
  const token = process.env.NOVELAI_TOKEN;

  // Initialize client with token authentication
  const client = new NovelAI({ token, verbose: true });

  try {
    const response = await client.generateImage(
      {
        prompt: "1girl, cute",
        negative_prompt: "1234",
        ucPreset: 3,
        scale: 5,
        seed: 3417044607,
        steps: 28,
        model: Model.V4_5,
        resPreset: Resolution.NORMAL_PORTRAIT,
        sampler: Sampler.EULER_ANC,
      },
      { stream: true },
    );

    // Ensure output directory exists
    fs.mkdirSync("./examples/output", { recursive: true });

    // Check if response is an AsyncGenerator (streaming) or Image array
    if (response && typeof response[Symbol.asyncIterator] === "function") {
      // Handle streaming response (AsyncGenerator)
      console.log("Handling streaming response...");
      for await (const event of response) {
        if (event.event_type === EventType.INTERMEDIATE) {
          await event.image.save(
            `./examples/output/image_${event.samp_ix}_step_${event.step_ix.toString().padStart(2, "0")}.jpg`,
          );
        } else if (event.event_type === EventType.FINAL) {
          await event.image.save(
            `./examples/output/image_${event.samp_ix}_result.png`,
          );
        }
      }
    } else if (Array.isArray(response)) {
      // Handle array of images (non-streaming)
      console.log("Handling non-streaming response...");
      for (let i = 0; i < response.length; i++) {
        await response[i].save(`./examples/output/image_${i}_result.png`);
      }
    } else {
      console.error("Unexpected response type:", typeof response);
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

// Run the test
if (require.main === module) {
  testModelV45Streaming().catch(console.error);
}

module.exports = { testModelV45Streaming };
