const { NovelAI } = require("nekoai-js");
require("dotenv").config();

async function main() {
  const client = new NovelAI({ token: process.env.NOVELAI_TOKEN });
  const result = await client.countTokens("1girl, blue hair");
  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
