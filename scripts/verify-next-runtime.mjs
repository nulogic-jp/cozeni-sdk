/**
 * Next.js導入例を、HEADをnpm packした配布物で実際にnext start（本番相当の
 * サーバー）まで起動して検証する。examples/nextjs/package.json は公開npmの
 * バージョン範囲を指すため、単に作業ツリーのexamples/nextjsをそのまま起動すると
 * 「install済みならたまたま動く」だけでHEADを検証したことにならない。
 * prepareExampleConsumer()でHEADのtarballを差し込んだ一時consumerを用意し、
 * そこでinstall・buildしてから起動する。
 *
 * Next.js 16（proxy.ts）と15（middleware.ts）の両方で同じシナリオを通す。
 * proxy / middlewareの実行環境（16はNode.js、15は既定でEdge）とCookieの扱いは
 * 版ごとに異なり、ユニットテストのモックでは確かめられないため。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { prepareExampleConsumer, run } from "./example-consumer.mjs";

// 例のコードに書かれた値。例を変えたらここも合わせる。
const productId = "prd_example";
const marker = "購入者だけに表示する本文";
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
  return createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        // 不正なJSONは空本文として扱う。
      }
      const scenario = /cozeni_customer=([^;]+)/.exec(
        request.headers.cookie ?? "",
      )?.[1];
      const send = (status, json) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(json));
      };
      if (request.url === "/external/v1/customer/entitlements/check") {
        const enterUrl = `${origin}/enter?product_id=${body.product_id}`;
        if (scenario === "scn-entitled") return send(200, { entitled: true });
        if (scenario === "scn-no-grant")
          return send(200, {
            entitled: false,
            reason: "no_grant",
            enter_url: enterUrl,
          });
        // Cookie無し・その他のトークンはno_sessionとして扱う。
        return send(401, {
          entitled: false,
          reason: "no_session",
          enter_url: enterUrl,
        });
      }
      if (request.url === "/external/v1/customer/handoff/exchange") {
        if (body.code === "valid-code")
          return send(200, { token: "scn-entitled" });
        return send(400, {
          error: {
            code: "invalid_code",
            message: "invalid",
            request_id: "req_mock",
          },
        });
      }
      send(404, {});
    });
  });
}

/** `next start`を起動する。 */
function startNext(directory, port, env) {
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

async function withNext(directory, apiOrigin, variant, verify) {
  const { label, siteHost } = variant;
  const port = await freePort();
  const origin = `http://${siteHost}:${port}`;
  const { child, exited } = startNext(directory, port, {
    COZENI_API_ORIGIN: apiOrigin,
    COZENI_SITE_ORIGIN: origin,
  });
  try {
    assert.ok(
      await waitReady(child, origin),
      `Next.js productionサーバーが起動しませんでした（${label}）。`,
    );
    await verify(origin);
  } finally {
    await stopNext(child, exited);
  }
}

const get = (origin, path, cookie, headers = {}) =>
  fetch(`${origin}${path}`, {
    redirect: "manual",
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
  });
const cookies = (response) => response.headers.getSetCookie();
// Next.jsはproxy / middlewareが返した同一オリジンのLocationを相対URLに書き換えるため、解決して比べる。
const locationOf = (response, origin) =>
  new URL(response.headers.get("location") ?? "", origin).href;
const mark = (response) =>
  cookies(response).find((cookie) => cookie.startsWith("cozeni_handoff="));
const setsCustomer = (response) =>
  cookies(response).some((cookie) => cookie.startsWith("cozeni_customer="));

// --- API接続不能（到達不能origin）。unavailableで拒否し、交換障害は印で伝える。 ---
async function verifyUnreachableApi(directory, variant) {
  await withNext(directory, "http://127.0.0.1:1", variant, async (origin) => {
    for (const headers of [{}, { RSC: "1" }]) {
      let response = await get(origin, "/members", undefined, headers);
      // Next.js 16はRSC要求をキャッシュ回避用の`?_rsc`付きURLへ一度だけ転送する。
      const location = response.headers.get("location") ?? "";
      if (
        headers.RSC &&
        response.status === 307 &&
        location.startsWith("/members?_rsc")
      )
        response = await get(origin, location, undefined, headers);
      assert.equal(response.status, 200, "接続不能時は拒否画面を表示する。");
      assert.ok(!(await response.text()).includes(marker), "本文を出さない。");
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    }
    const handoff = await get(origin, "/members?cozeni_code=runtime-code");
    assert.equal(handoff.status, 303, "交換障害でもコードを除いて戻す。");
    assert.equal(locationOf(handoff, origin), `${origin}/members`);
    assert.match(mark(handoff) ?? "", /^cozeni_handoff=unavailable;/);
    assert.ok(!setsCustomer(handoff), "交換障害では購入者Cookieを変えない。");

    const files = await readdir(join(directory, ".next/static/chunks"));
    const chunk = files.find((file) => file.endsWith(".js"));
    assert.ok(chunk, "検証対象の静的JSがありません。");
    const asset = await fetch(`${origin}/_next/static/chunks/${chunk}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.doesNotMatch(asset.headers.get("cache-control") ?? "", /no-store/);
  });
}

// --- モックAPIで、ハンドオフ・印・enter_url・Route Handlerを検証する。 ---
async function verifyMockedApi(directory, variant) {
  const apiPort = await freePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const mockApi = createMockCozeniApi(apiOrigin);
  await new Promise((resolve) => mockApi.listen(apiPort, "127.0.0.1", resolve));
  const enterUrl = `${apiOrigin}/enter?product_id=${productId}`;
  try {
    await withNext(directory, apiOrigin, variant, async (origin) => {
      // 未購入（Cookie無し）はenter_urlへリダイレクトする。
      const anonymous = await get(origin, "/members");
      assert.equal(anonymous.status, 307, "未購入はenter_urlへredirectする。");
      assert.equal(anonymous.headers.get("location"), enterUrl);

      // 交換成功: Cookieと印を設定し、コードだけを除いた同じURLへ303で戻す。
      const handoff = await get(
        origin,
        "/members?ref=mail&cozeni_code=valid-code",
      );
      assert.equal(handoff.status, 303);
      assert.equal(locationOf(handoff, origin), `${origin}/members?ref=mail`);
      assert.ok(
        cookies(handoff).some((cookie) =>
          /^cozeni_customer=scn-entitled;.*HttpOnly/.test(cookie),
        ),
        "購入者CookieをHttpOnlyで設定する。",
      );
      assert.match(mark(handoff) ?? "", /^cozeni_handoff=ok;.*Max-Age=60/);

      // 戻った次のリクエスト: 本文を表示し、応答で印を消す。
      const settled = await get(
        origin,
        "/members?ref=mail",
        "cozeni_customer=scn-entitled; cozeni_handoff=ok",
      );
      assert.equal(settled.status, 200);
      assert.ok((await settled.text()).includes(marker), "本文を表示する。");
      assert.match(mark(settled) ?? "", /^cozeni_handoff=;.*Max-Age=0/);

      // 交換失敗: 購入者Cookieを設定せず、invalid_codeの印で戻す。
      const failed = await get(origin, "/members?cozeni_code=used-code");
      assert.equal(failed.status, 303);
      assert.equal(locationOf(failed, origin), `${origin}/members`);
      assert.match(mark(failed) ?? "", /^cozeni_handoff=invalid_code;/);
      assert.ok(!setsCustomer(failed));

      // 印がある間の拒否はenter_urlへ戻さない（無限リダイレクトの回避）。
      // 印はページから見えたまま、応答で消える。
      const halted = await get(
        origin,
        "/members",
        "cozeni_handoff=invalid_code",
      );
      assert.equal(halted.status, 200, "印付きの拒否はredirectしない。");
      assert.ok(!(await halted.text()).includes(marker));
      assert.match(mark(halted) ?? "", /^cozeni_handoff=;.*Max-Age=0/);
      const haltedGrant = await get(
        origin,
        "/members",
        "cozeni_customer=scn-no-grant; cozeni_handoff=ok",
      );
      assert.equal(haltedGrant.status, 200);

      // 印が消えた後の再読込は、通常どおりenter_urlへ1回リダイレクトする。
      const reloaded = await get(
        origin,
        "/members",
        "cozeni_customer=scn-no-grant",
      );
      assert.equal(reloaded.status, 307);
      assert.equal(reloaded.headers.get("location"), enterUrl);

      // 交換障害の印は、再入場ではなく障害として案内する。
      const unavailable = await get(
        origin,
        "/members",
        "cozeni_handoff=unavailable",
      );
      assert.equal(unavailable.status, 200);
      assert.match(await unavailable.text(), /時間をおいて再試行してください/);

      // Route Handlerはredirectせず、enter_urlをJSON本文へ含めて返す。
      const api = await get(
        origin,
        "/api/protected",
        "cozeni_customer=scn-no-grant",
      );
      assert.equal(api.status, 403, "Route Handlerはredirectしない。");
      assert.equal(api.headers.has("location"), false);
      assert.deepEqual(await api.json(), {
        error: "no_grant",
        enter_url: enterUrl,
      });
    });
  } finally {
    await new Promise((resolve) => mockApi.close(resolve));
  }
}

// Next.js 15のmiddlewareは、リダイレクト先のループバックのホスト名（127.0.0.1）を
// localhostへ書き換える。ホスト単位のCookieが届かなくなるため、15ではlocalhostで開発する
// （README参照）。実在のドメインでは書き換えは起きない。
const variants = [
  { label: "Next.js 16 / proxy.ts", siteHost: "127.0.0.1" },
  {
    label: "Next.js 15 / middleware.ts",
    siteHost: "localhost",
    next: "^15.5.4",
    middleware: true,
  },
];
let packedName = "";
for (const variant of variants) {
  const { packed, consumer, cleanup } = await prepareExampleConsumer(
    "cozeni-runtime-check-",
    variant,
  );
  packedName = `${packed.name}@${packed.version}`;
  try {
    run("bun", ["install"], consumer);
    run("bun", ["run", "build"], consumer, { NEXT_TELEMETRY_DISABLED: "1" });
    const installed = JSON.parse(
      await readFile(join(consumer, "node_modules/next/package.json"), "utf8"),
    ).version;
    const label = `${variant.label}（next ${installed}）`;
    await verifyUnreachableApi(consumer, { ...variant, label });
    await verifyMockedApi(consumer, { ...variant, label });
    console.log(`実HTTP回帰成功: ${label}`);
  } finally {
    await cleanup();
  }
}
console.log(
  `実HTTP回帰成功: ${packedName} の配布物で` +
    "ハンドオフの交換とコード除去・停止条件の印の設定と消去・enter_urlへのredirect・" +
    "接続不能時の拒否画面・Route Handlerの非redirect・静的JSキャッシュ維持（Next.js 15・16）",
);
