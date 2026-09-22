import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(
  new URL("../examples/nextjs/", import.meta.url),
);
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", resolve);
});
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const marker = "レビュー回帰検証用の保護本文";
// 実環境の接続値・管理キーを使わず、外部APIにも接続しない。
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("COZENI_")),
);
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "-H",
    "127.0.0.1",
    "-p",
    String(port),
  ],
  {
    cwd: directory,
    stdio: "ignore",
    env: {
      ...environment,
      NEXT_TELEMETRY_DISABLED: "1",
      COZENI_API_ORIGIN: "http://127.0.0.1:1",
      COZENI_SITE_ORIGIN: origin,
      COZENI_PRODUCT_ID: "review_fixture",
      COZENI_CHECKOUT_URL: `${origin}/checkout`,
      COZENI_OTP_URL: "",
      COZENI_PROTECTED_CONTENT: marker,
    },
  },
);
const exited = new Promise((resolve) => {
  child.once("exit", resolve);
  child.once("error", resolve);
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) break;
    try {
      await fetch(origin, { signal: AbortSignal.timeout(1000) });
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert.ok(ready, "Next.js productionサーバーが起動しませんでした。");
  const handoffCode = "runtime-handoff-code";
  const handoff = await fetch(`${origin}/members?cozeni_code=${handoffCode}`, {
    redirect: "manual",
  });
  assert.equal(
    handoff.status,
    307,
    "handoffコードを受けたページは交換入口へ一度だけ転送する。",
  );
  assert.equal(
    new URL(handoff.headers.get("location") ?? "", origin).href,
    `${origin}/cozeni/handoff?cozeni_code=${handoffCode}`,
    "handoffコードを交換入口へ渡す。",
  );
  for (const headers of [{}, { RSC: "1" }]) {
    const response = await fetch(`${origin}/members`, { headers });
    assert.equal(response.status, 200, "OTP URL未設定でも拒否画面を表示する。");
    assert.ok(
      !(await response.text()).includes(marker),
      "保護本文を表示しない。",
    );
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  const files = await readdir(
    new URL("../examples/nextjs/.next/static/chunks/", import.meta.url),
  );
  const chunk = files.find((file) => file.endsWith(".js"));
  assert.ok(chunk, "検証対象の静的JSがありません。");
  const asset = await fetch(`${origin}/_next/static/chunks/${chunk}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
  assert.doesNotMatch(asset.headers.get("cache-control") ?? "", /no-store/);
  console.log(
    "実HTTP回帰成功: handoff転送・OTP URLなしのHTML/RSC拒否画面・本文非混入・静的JSキャッシュ維持",
  );
} finally {
  child.kill("SIGTERM");
  // 自分で起動したプロセスだけを終了し、他のローカルサーバーには触れない。
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  timer.unref();
  await exited;
  clearTimeout(timer);
}
