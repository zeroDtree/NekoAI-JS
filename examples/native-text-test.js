const { NovelAI, TextModel } = require("nekoai-js");
require("dotenv").config();

async function main() {
  const client = new NovelAI({ token: process.env.NOVELAI_TOKEN });

  const result = await client.generateText("The old lighthouse keeper", {
    model: TextModel.ERATO,
    max_length: 120,
    temperature: 0.9,
  });
  console.log(result.output);

  const stream = await client.generateTextStream("Once upon a time");
  for await (const token of stream) process.stdout.write(token);
  process.stdout.write("\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
