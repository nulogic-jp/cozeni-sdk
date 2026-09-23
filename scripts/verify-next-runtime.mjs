import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(
  new URL("../examples/nextjs/", import.meta.url),
);
const marker = "レビュー回帰検証用の保護本文";
const productId = "review_fixture";
// 実環境の接続値・管理キーを使わず、外部APIにも接続しない。
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("COZENI_")),
);

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Cozeni外部APIの権利確認・ハンドオフ交換だけを模した最小モック。
 * Cookieの`cozeni_customer`値をそのままシナリオ切り替えのキーとして使う
 * （テストのfetchが任意のCookie値を送れるため、実際の購入者トークンとは無関係）。
 */
function createMockCozeniApi(origin) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        // 不正なJSONは空本文として扱う。
      }
      const cookieHeader = request.headers.cookie ?? "";
      const scenario = /cozeni_customer=([^;]+)/.exec(cookieHeader)?.[1];
      const send = (status, json) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(json));
      };
      if (request.url === "/external/v1/customer/entitlements/check") {
        const enterUrl = `${origin}/enter?product_id=${body.product_id}`;
        if (scenario === "scn-entitled" || scenario === "scn-normalize") {
          return send(200, { entitled: true });
        }
        if (scenario === "scn-no-grant") {
          return send(200, {
            entitled: false,
            reason: "no_grant",
            enter_url: enterUrl,
          });
        }
        // Cookie無し・その他のトークンはno_sessionとして扱う。
        return send(401, {
          entitled: false,
          reason: "no_session",
          enter_url: enterUrl,
        });
      }
      if (request.url === "/external/v1/customer/handoff/exchange") {
        if (body.code === "valid-code") {
          return send(200, { token: "scn-normalize" });
        }
        return send(400, {
          error: {
            code: "invalid_code",
            message: "invalid",
            request_id: "req_mock",
          },
        });
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  return server;
}

/** `next start`を起動し、応答可能になるまで待つ。 */
function startNext(port, env) {
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
      env: { ...environment, NEXT_TELEMETRY_DISABLED: "1", ...env },
    },
  );
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  return { child, exited };
}

async function waitReady(child, origin) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) break;
    try {
      await fetch(origin, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

async function stopNext(child, exited) {
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  timer.unref();
  await exited;
  clearTimeout(timer);
}

// --- シナリオ1: API接続不能（既存の到達不能origin）。unavailableで拒否する。 ---
async function verifyUnreachableApi() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const { child, exited } = startNext(port, {
    COZENI_API_ORIGIN: "http://127.0.0.1:1",
    COZENI_SITE_ORIGIN: origin,
    COZENI_PRODUCT_ID: productId,
    COZENI_CHECKOUT_URL: `${origin}/checkout`,
    COZENI_PROTECTED_CONTENT: marker,
  });
  try {
    assert.ok(
      await waitReady(child, origin),
      "Next.js productionサーバーが起動しませんでした。",
    );
    const handoffCode = "runtime-handoff-code";
    const handoff = await fetch(
      `${origin}/members?cozeni_code=${handoffCode}`,
      {
        redirect: "manual",
      },
    );
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
    // 実APIに接続できない(COZENI_API_ORIGINが到達不能)ためunavailableとなり、
    // enter_urlへは自動リダイレクトされず拒否画面を表示する。
    for (const headers of [{}, { RSC: "1" }]) {
      const response = await fetch(`${origin}/members`, {
        headers,
        redirect: "manual",
      });
      assert.equal(response.status, 200, "接続不能時は拒否画面を表示する。");
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
  } finally {
    await stopNext(child, exited);
  }
}

// --- シナリオ2: モックAPIで拒否・enter_url・停止条件・正規化・Route Handlerを検証する。 ---
async function verifyMockedApi() {
  const apiPort = await freePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const mockApi = createMockCozeniApi(apiOrigin);
  await new Promise((resolve) => mockApi.listen(apiPort, "127.0.0.1", resolve));

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const { child, exited } = startNext(port, {
    COZENI_API_ORIGIN: apiOrigin,
    COZENI_SITE_ORIGIN: origin,
    COZENI_PRODUCT_ID: productId,
    COZENI_CHECKOUT_URL: `${origin}/checkout`,
    COZENI_PROTECTED_CONTENT: marker,
  });
  try {
    assert.ok(
      await waitReady(child, origin),
      "Next.js productionサーバーが起動しませんでした（モックAPI経路）。",
    );
    const enterUrl = `${apiOrigin}/enter?product_id=${productId}`;

    // 通常の拒否（no_grant）はenter_urlへ1回リダイレクトする。
    const denied = await fetch(`${origin}/members`, {
      redirect: "manual",
      headers: { Cookie: "cozeni_customer=scn-no-grant" },
    });
    assert.equal(denied.status, 307, "拒否時はenter_urlへredirectする。");
    assert.equal(
      denied.headers.get("location"),
      enterUrl,
      "redirect先はAPIが返したenter_url。",
    );

    // ハンドオフ成功直後の印（cozeni_handoff）が付いていれば、拒否でも
    // enter_urlへ再リダイレクトせず拒否画面に留める（無限リダイレクトの回避）。
    const halted = await fetch(`${origin}/members?cozeni_handoff=1`, {
      redirect: "manual",
      headers: { Cookie: "cozeni_customer=scn-no-grant" },
    });
    assert.equal(
      halted.status,
      200,
      "ハンドオフ成功直後の印付き拒否はredirectしない。",
    );
    assert.ok(
      !(await halted.text()).includes(marker),
      "保護本文を表示しない。",
    );

    // cozeni_error付きでも同様に停止する。
    const haltedByError = await fetch(
      `${origin}/members?cozeni_error=invalid_code`,
      {
        redirect: "manual",
        headers: { Cookie: "cozeni_customer=scn-no-grant" },
      },
    );
    assert.equal(
      haltedByError.status,
      200,
      "交換失敗直後(cozeni_error)の拒否はredirectしない。",
    );

    // ハンドオフ成功→cozeni_handoff付きで/membersへ。権利があるので
    // 印を外したURLへ正規化する（ループしない）。
    const normalized = await fetch(`${origin}/members?cozeni_handoff=1`, {
      redirect: "manual",
      headers: { Cookie: "cozeni_customer=scn-normalize" },
    });
    assert.equal(
      normalized.status,
      307,
      "権利があれば正規化のredirectをする。",
    );
    assert.equal(
      normalized.headers.get("location"),
      `${origin}/members`,
      "印を外したクリーンなURLへ正規化する。",
    );
    // 正規化後のURLへ実際にたどり着いても再びredirectしない（ループしない）。
    const settled = await fetch(`${origin}/members`, {
      redirect: "manual",
      headers: { Cookie: "cozeni_customer=scn-normalize" },
    });
    assert.equal(settled.status, 200);
    assert.ok(
      (await settled.text()).includes(marker),
      "権利があれば保護本文を表示する。",
    );

    // 実際のハンドオフ交換→Set-Cookie→印付きredirectの一連の流れも確認する。
    const handoffSuccess = await fetch(
      `${origin}/cozeni/handoff?cozeni_code=valid-code`,
      { redirect: "manual" },
    );
    assert.equal(handoffSuccess.status, 303);
    assert.equal(
      handoffSuccess.headers.get("location"),
      `${origin}/members?cozeni_handoff=1`,
      "ハンドオフ成功直後は印付きURLへ戻す。",
    );
    assert.match(
      handoffSuccess.headers.get("set-cookie") ?? "",
      /cozeni_customer=scn-normalize/,
    );

    // Route Handlerはredirectせず、enter_urlをJSON本文へ含めて返す。
    const api = await fetch(`${origin}/api/protected`, {
      redirect: "manual",
      headers: { Cookie: "cozeni_customer=scn-no-grant" },
    });
    assert.equal(api.status, 403, "Route Handlerはredirectしない。");
    assert.equal(api.headers.has("location"), false);
    assert.deepEqual(await api.json(), {
      error: "no_grant",
      enter_url: enterUrl,
    });
  } finally {
    await stopNext(child, exited);
    await new Promise((resolve) => mockApi.close(resolve));
  }
}

await verifyUnreachableApi();
await verifyMockedApi();
console.log(
  "実HTTP回帰成功: handoff転送・接続不能時の拒否画面・enter_urlへのredirect・" +
    "ハンドオフ成功直後の停止と正規化・Route Handlerの非redirect・静的JSキャッシュ維持",
);
