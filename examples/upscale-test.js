const { NovelAI, Model } = require("nekoai-js");
require("dotenv").config();

async function main() {
  const client = new NovelAI({ token: process.env.NOVELAI_TOKEN });
  const image = await client.upscale("./examples/input/_image.png", {
    model: Model.V4_5,
    declaredBlurSigma: 0.3,
  });
  await image.save("./examples/output/upscaled.png");
  console.log("Saved examples/output/upscaled.png");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
