import { prepareExampleConsumer, run } from "./example-consumer.mjs";

const { packed, consumer, cleanup } = await prepareExampleConsumer(
  "cozeni-example-check-",
);
try {
  // prepackのbuildは呼び出し側（bun run check）が済ませている。
  run("bun", ["install"], consumer);
  run("bun", ["run", "test"], consumer);
  run("bun", ["run", "build"], consumer, { NEXT_TELEMETRY_DISABLED: "1" });

  console.log(
    `導入例検証成功: ${packed.name}@${packed.version} の配布物でNext.js例のテストとビルドが通りました`,
  );
} finally {
  await cleanup();
}
