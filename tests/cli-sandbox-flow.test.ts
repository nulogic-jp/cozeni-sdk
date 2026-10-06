// サンドボックスで実装→テスト購入→本番へ切り替える流れ（V-20〜V-26）の CLI 側。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliContext, run } from "../src/cli/run.js";
import { createStore } from "../src/cli/store.js";

const PROD_API = "https://api.cozeni.net";
const PROD_APP = "https://cozeni.net";
const SBX_API = "https://api-sandbox.cozeni.net";
const SBX_APP = "https://sandbox.cozeni.net";
// 購入者面（checkout / enter）。本体は enter_url を CHECKOUT_BASE_URL から組み立てる（N-2）。
const SBX_CHECKOUT = "https://checkout-sandbox.cozeni.net";
const SITE = "http://localhost:3000";
const START = Date.parse("2026-10-06T00:00:00.000Z");
const PRODUCT_ID = `prd_${"0".repeat(32)}`;
const sandboxKey = `cozeni_sk_sandbox_${"a".repeat(64)}`;
const productionKey = `cozeni_sk_${"b".repeat(64)}`;
// 出力に出てはいけない秘密。
const HANDOFF_CODE = "handoff_code_secret_value";
const CUSTOMER_COOKIE = "customer_cookie_secret_value";

type Call = {
  method: string;
  url: string;
  headers: Headers;
  now: number;
  signal?: AbortSignal | null;
};
type Handler = (call: Call) => Response | Promise<Response>;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const apiError = (code: string, status: number, extra = {}) =>
  json(
    { error: { code, message: code, request_id: "req_test", ...extra } },
    status,
  );

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cozeni-flow-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function cli(handler: Handler, extraEnv: Record<string, string> = {}) {
  const state = { now: START };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Call[] = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        method: init?.method ?? "GET",
        url: String(input),
        headers: new Headers(init?.headers),
        now: state.now,
        signal: init?.signal,
      };
      calls.push(call);
      return handler(call);
    },
  );
  const context = (argv: string[]): CliContext => ({
    argv,
    env: { XDG_CONFIG_HOME: home, HOME: home, CLAUDECODE: "1", ...extraEnv },
    cwd: home,
    stdout: { write: (text) => void stdout.push(text) },
    stderr: { write: (text) => void stderr.push(text) },
    interactiveTerminal: false,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => state.now,
    sleep: async (ms) => {
      state.now += ms;
    },
    openBrowser: () => {},
    prompt: async () => "n",
    onLine: () => () => {},
    runCommand: async () => {
      throw new Error("このテストでは子プロセスを起動しない");
    },
  });
  return {
    calls,
    fetch,
    state,
    async run(...argv: string[]) {
      stdout.length = 0;
      stderr.length = 0;
      const code = await run(context(argv));
      return { code, out: stdout.join(""), err: stderr.join("") };
    },
    parsed() {
      const text = stdout.join("");
      expect(text.trim().split("\n")).toHaveLength(1);
      return JSON.parse(text);
    },
  };
}

const store = () => createStore({ XDG_CONFIG_HOME: home });
/** 本番の管理画面のプロンプトの init の後の状態（V-20）。 */
async function sandboxFirst(creator = "cre_1") {
  await store().saveConfig({
    version: 1,
    default_profile: "sandbox",
    flow: "sandbox-first",
    profiles: { production: { expected_creator_id: creator }, sandbox: {} },
  });
}
async function saveCredential(
  profile: "production" | "sandbox",
  creator = "cre_1",
) {
  const sandbox = profile === "sandbox";
  await store().saveCredential(profile, {
    api_origin: sandbox ? SBX_API : PROD_API,
    app_origin: sandbox ? SBX_APP : PROD_APP,
    api_key: sandbox ? sandboxKey : productionKey,
    key_id: "key_1",
    creator_id: creator,
    environment: profile,
    expires_at: "2026-11-05T00:00:00.000Z",
  });
}
const defaultProfile = async () => (await store().loadConfig()).default_profile;

const account = (environment: string, creator = "cre_1", sales?: unknown) => ({
  creator_id: creator,
  api_key_id: "key_1",
  scopes: ["products:read", "products:write"],
  environment,
  api_version: "v1",
  ...(sales ? { sales } : {}),
});

describe("本番への切り替え（switch）", () => {
  it("本番にログイン済みで期待するクリエイターと一致すれば、既定を production にする", async () => {
    await sandboxFirst();
    await saveCredential("production");
    const t = cli(() => json(account("production")));
    expect((await t.run("switch", "--json")).code).toBe(0);
    expect(t.parsed().data).toMatchObject({
      switched: true,
      default_profile: "production",
      previous_profile: "sandbox",
      creator_id: "cre_1",
    });
    expect(t.parsed().data.next_step).toContain("COZENI_ENVIRONMENT");
    expect(t.parsed().data.next_step).toContain("products create");
    expect(await defaultProfile()).toBe("production");
    // キーは本番にだけ送る。
    expect(t.calls.every((call) => call.url.startsWith(PROD_API))).toBe(true);
  });
  it("未ログインなら既定を変えず、本番のログインを案内する", async () => {
    await sandboxFirst();
    const t = cli(() => json({}, 500));
    const { code } = await t.run("switch", "--json");
    expect(code).toBe(3);
    expect(t.parsed().error.code).toBe("login_required");
    expect(t.parsed().error.hint).toContain("login --profile production");
    expect(await defaultProfile()).toBe("sandbox");
  });
  it("別のクリエイターなら既定を変えずに止まる", async () => {
    await sandboxFirst("cre_1");
    await saveCredential("production", "cre_other");
    const t = cli(() => json(account("production", "cre_other")));
    const { code } = await t.run("switch", "--json");
    expect(code).toBe(4);
    expect(t.parsed().error.code).toBe("creator_mismatch");
    expect(await defaultProfile()).toBe("sandbox");
  });
  it("本番で使うアカウントが保存されていなければ、initのやり直しを案内する", async () => {
    const t = cli(() => json({}, 500));
    const { code } = await t.run("switch", "--json");
    expect(code).toBe(2);
    expect(t.parsed().error.hint).toContain("init");
  });
});

describe("本番へのログイン（V-23）", () => {
  const productionDeviceCode = {
    device_code: "dev_secret_code_value",
    user_code: "BCDF-GHJK",
    verification_uri: `${PROD_APP}/device`,
    verification_uri_complete: `${PROD_APP}/device?code=BCDF-GHJK`,
    expires_in: 600,
    interval: 5,
  };
  const token = (creator = "cre_1") => ({
    api_key: productionKey,
    key_id: "key_2",
    creator_id: creator,
    environment: "production",
    expires_at: "2026-11-05T00:00:00.000Z",
  });

  it("ログイン済みで一致していれば承認を求めず、本番への導入の許可を得ているか確かめてから切り替えるよう案内し、既定は変えない", async () => {
    await sandboxFirst();
    await saveCredential("production");
    const t = cli(() => json(account("production")));
    expect(
      (await t.run("login", "--profile", "production", "--json")).code,
    ).toBe(0);
    const data = t.parsed().data;
    expect(data.already_logged_in).toBe(true);
    expect(data.next_step).toContain("本番を導入してよいですか");
    expect(data.next_step).toContain("許可をすでに得ていれば");
    expect(data.next_step).toContain("npx cozeni switch");
    expect(await defaultProfile()).toBe("sandbox");
  });
  it("承認が完了して一致すれば、既定を production に書き換え、差し替えの手順を返す", async () => {
    await sandboxFirst();
    const t = cli(({ url }) =>
      url.endsWith("/cli/device-codes")
        ? json(productionDeviceCode)
        : url.endsWith("/cli/tokens")
          ? json(token())
          : json({}, 404),
    );
    await t.run("login", "--profile", "production", "--json");
    expect(
      (await t.run("login", "--complete", "--profile", "production", "--json"))
        .code,
    ).toBe(0);
    expect(t.parsed().data).toMatchObject({
      profile: "production",
      default_profile: "production",
      switched_to_production: true,
    });
    expect(t.parsed().data.next_step).toContain("COZENI_ENVIRONMENT");
    expect(await defaultProfile()).toBe("production");
  });
  it("クリエイターが違えば保存も切り替えもしない", async () => {
    await sandboxFirst("cre_1");
    const t = cli(({ url }) =>
      url.endsWith("/cli/device-codes")
        ? json(productionDeviceCode)
        : url.endsWith("/cli/tokens")
          ? json(token("cre_other"))
          : json({}, 200),
    );
    await t.run("login", "--profile", "production", "--json");
    const { code } = await t.run(
      "login",
      "--complete",
      "--profile",
      "production",
      "--json",
    );
    expect(code).toBe(4);
    expect(t.parsed().error.code).toBe("creator_mismatch");
    expect(await defaultProfile()).toBe("sandbox");
    expect(await store().loadCredential("production")).toBeUndefined();
  });
  it("サンドボックスのログインでは切り替えない", async () => {
    await sandboxFirst();
    const t = cli(({ url }) =>
      url.endsWith("/cli/device-codes")
        ? json({
            ...productionDeviceCode,
            verification_uri: `${SBX_APP}/device`,
            verification_uri_complete: `${SBX_APP}/device?code=BCDF-GHJK`,
          })
        : url.endsWith("/cli/tokens")
          ? json({ ...token(), api_key: sandboxKey, environment: "sandbox" })
          : json({}, 404),
    );
    await t.run("login", "--json");
    expect((await t.run("login", "--complete", "--json")).code).toBe(0);
    expect(t.parsed().data.switched_to_production).toBeUndefined();
    expect(await defaultProfile()).toBe("sandbox");
  });
  it("既定がサンドボックス以外（開発用プロファイルなど）なら、本番にログインしても切り替えない", async () => {
    await store().saveConfig({
      version: 1,
      default_profile: "dev",
      profiles: {
        production: { expected_creator_id: "cre_1" },
        dev: {
          api_origin: "http://localhost:8787",
          app_origin: "http://localhost:5173",
        },
      },
    });
    const t = cli(({ url }) =>
      url.endsWith("/cli/device-codes")
        ? json(productionDeviceCode)
        : json(token()),
    );
    await t.run("login", "--profile", "production", "--json");
    await t.run("login", "--complete", "--profile", "production", "--json");
    expect(await defaultProfile()).toBe("dev");
  });
  it("サンドボックスのログインの案内は、名前の説明と会員登録を含む。本番のログインには含めない", async () => {
    await sandboxFirst();
    const sandbox = cli(() =>
      json({
        ...productionDeviceCode,
        verification_uri: `${SBX_APP}/device`,
        verification_uri_complete: `${SBX_APP}/device?code=BCDF-GHJK`,
      }),
    );
    await sandbox.run("login", "--json");
    const step = sandbox.parsed().data.next_step as string;
    expect(step).toContain(
      "実際にはお金が動かないテスト用の環境（サンドボックス）",
    );
    expect(step).toContain("会員登録");
    expect(step).toContain("npx cozeni login --complete");
    const production = cli(() => json(productionDeviceCode));
    await production.run("login", "--profile", "production", "--json");
    expect(production.parsed().data.next_step).not.toContain("サンドボックス");
  });
});

describe("外部レビューの指摘（切り替え）", () => {
  it("導入の流れが未保存（0.6.0 より前の設定）なら、switch も自動の切り替えも進めず init のやり直しを案内する", async () => {
    await store().saveConfig({
      version: 1,
      default_profile: "sandbox",
      profiles: { production: { expected_creator_id: "cre_1" }, sandbox: {} },
    });
    await saveCredential("production");
    const t = cli(() => json(account("production")));
    expect((await t.run("switch", "--json")).code).toBe(2);
    expect(t.parsed().error.hint).toContain("init");
    expect(await defaultProfile()).toBe("sandbox");
    await store().removeCredential("production");
    const login = cli(({ url }) =>
      url.endsWith("/cli/device-codes")
        ? json({
            device_code: "dev_secret_code_value",
            user_code: "BCDF-GHJK",
            verification_uri: `${PROD_APP}/device`,
            expires_in: 600,
            interval: 5,
          })
        : json({
            api_key: productionKey,
            key_id: "key_2",
            creator_id: "cre_1",
            environment: "production",
            expires_at: "2026-11-05T00:00:00.000Z",
          }),
    );
    await login.run("login", "--profile", "production", "--json");
    await login.run("login", "--complete", "--profile", "production", "--json");
    expect(login.parsed().data.next_step).toContain("init");
    expect(await defaultProfile()).toBe("sandbox");
  });
  it("switch は本番の GET /account で確かめ、保存したキーのローカルの値だけを信じない", async () => {
    await sandboxFirst("cre_1");
    await saveCredential("production", "cre_1");
    const t = cli(() => json(account("production", "cre_other")));
    expect((await t.run("switch", "--json")).code).toBe(4);
    expect(t.parsed().error.code).toBe("creator_mismatch");
    expect(await defaultProfile()).toBe("sandbox");
  });
  it("switch は失効したキーなら既定を変えない", async () => {
    await sandboxFirst("cre_1");
    await saveCredential("production", "cre_1");
    const t = cli(() => apiError("unauthorized", 401));
    expect((await t.run("switch", "--json")).code).toBe(3);
    expect(await defaultProfile()).toBe("sandbox");
  });
  it("サンドボックスだけの導入では、過去の本番の期待値があっても自動で切り替えず、switch も断る", async () => {
    await store().saveConfig({
      version: 1,
      default_profile: "sandbox",
      flow: "sandbox-only",
      profiles: {
        production: { expected_creator_id: "cre_1" },
        sandbox: { expected_creator_id: "cre_1" },
      },
    });
    await saveCredential("production");
    const login = cli(() => json(account("production")));
    await login.run("login", "--profile", "production", "--json");
    expect(login.parsed().data.next_step).not.toContain("切り替えてよいですか");
    const t = cli(() => json(account("production")));
    expect((await t.run("switch", "--json")).code).toBe(2);
    expect(await defaultProfile()).toBe("sandbox");
  });
  it("ログインを待つあいだに別の導入が設定を変えたら、切り替えず、その設定を巻き戻さない", async () => {
    await sandboxFirst("cre_1");
    const t = cli(async ({ url }) => {
      if (url.endsWith("/cli/device-codes"))
        return json({
          device_code: "dev_secret_code_value",
          user_code: "BCDF-GHJK",
          verification_uri: `${PROD_APP}/device`,
          verification_uri_complete: `${PROD_APP}/device?code=BCDF-GHJK`,
          expires_in: 600,
          interval: 5,
        });
      // 待っているあいだに、別の導入が init --creator cre_B を保存する。
      await sandboxFirst("cre_B");
      return json({
        api_key: productionKey,
        key_id: "key_2",
        creator_id: "cre_1",
        environment: "production",
        expires_at: "2026-11-05T00:00:00.000Z",
      });
    });
    await t.run("login", "--profile", "production", "--json");
    expect(
      (await t.run("login", "--complete", "--profile", "production", "--json"))
        .code,
    ).toBe(0);
    expect(t.parsed().data).toMatchObject({ switch_aborted: true });
    expect(t.parsed().data.switched_to_production).toBeUndefined();
    const latest = await store().loadConfig();
    expect(latest.default_profile).toBe("sandbox");
    expect(latest.profiles.production?.expected_creator_id).toBe("cre_B");
  });
});

describe("status（サンドボックスの Stripe 連携）", () => {
  const blocked = {
    can_sell: false,
    blockers: [
      {
        code: "stripe_not_connected",
        action_url: `${SBX_APP}/settings/stripe`,
      },
    ],
    warnings: [],
  };
  it("連携が未完了なら、商品の確認と同じ1通で頼み、連携を待たずに進めるよう案内する", async () => {
    await sandboxFirst();
    await saveCredential("sandbox");
    const t = cli(({ url }) =>
      url.endsWith("/account")
        ? json(account("sandbox", "cre_1", blocked))
        : json({ items: [], next_cursor: null }),
    );
    expect((await t.run("status", "--json")).code).toBe(0);
    const data = t.parsed().data;
    expect(data.next_step).toContain("テスト用の Stripe 連携");
    expect(data.next_step).toContain("000-000");
    expect(data.next_step).toContain(`${SBX_APP}/settings/stripe`);
    expect(data.next_step).toContain("test-purchase");
    expect(data.next_step).toContain("products create");
    expect(data.message_for_user.join("\n")).toContain(
      "テスト用の Stripe 連携",
    );
    expect(data.message_for_user.join("\n")).not.toContain("サンドボックス");
  });
  it("本番では従来の案内のまま", async () => {
    await saveCredential("production");
    const t = cli(({ url }) =>
      url.endsWith("/account")
        ? json(
            account("production", "cre_1", {
              ...blocked,
              blockers: [
                { code: "stripe_not_connected", action_url: `${PROD_APP}/x` },
              ],
            }),
          )
        : json({ items: [], next_cursor: null }),
    );
    await t.run("status", "--json");
    expect(t.parsed().data.next_step).toMatch(/^npx cozeni products create/);
    expect(t.parsed().data.message_for_user.join("\n")).toContain(
      "Stripeアカウントを接続してください。",
    );
  });
});

describe("test-purchase", () => {
  const product = {
    id: PRODUCT_ID,
    name: "ハンドブック",
    price_jpy: 1000,
    access_url: "https://site.example/members/handbook",
    currency: "jpy",
    status: "active",
    created_at: "2026-10-06T00:00:00.000Z",
    updated_at: "2026-10-06T00:00:00.000Z",
  };
  const start = `${SBX_API}/external/v1/products/${PRODUCT_ID}/test-purchase`;
  const refund = `${start}/refund`;
  const enterUrl = `${SBX_CHECKOUT}/enter?product_id=${PRODUCT_ID}`;

  /** 開発サーバー（SDK の proxy）の振る舞い。 */
  function site(
    options: {
      handoff?: "ok" | "invalid_code";
      open?: boolean;
      codeIgnored?: boolean;
      // 権利が付かない（交換は成功するが、購入権が無い）。
      noGrant?: boolean;
      // 未購入のときに送る入場画面（既定はサンドボックスの購入者面）。
      enter?: string;
    } = {},
  ): Handler {
    const enter = options.enter ?? enterUrl;
    return ({ url, headers }) => {
      const target = new URL(url);
      if (target.searchParams.has("cozeni_code")) {
        if (options.codeIgnored) return new Response("ok", { status: 200 });
        const response = new Response(null, {
          status: 303,
          headers: { Location: `${SITE}${target.pathname}` },
        });
        response.headers.append(
          "Set-Cookie",
          `cozeni_customer=${CUSTOMER_COOKIE}; Path=/; HttpOnly`,
        );
        response.headers.append(
          "Set-Cookie",
          `cozeni_handoff=${options.handoff ?? "ok"}; Path=/; Max-Age=60`,
        );
        return response;
      }
      const cookie = headers.get("Cookie") ?? "";
      // 印が付いた要求は、権利が無くてもリダイレクトせず、200の拒否表示を返す（11 §8.3）。
      if (options.noGrant)
        return cookie.includes("cozeni_handoff=")
          ? new Response("表示できません", { status: 200 })
          : new Response(null, {
              status: 307,
              headers: { Location: enter },
            });
      if (options.open || cookie.includes("cozeni_customer="))
        return new Response("限定ページ", { status: 200 });
      return new Response(null, {
        status: 307,
        headers: { Location: enter },
      });
    };
  }

  function api(overrides: {
    accessUrl?: string;
    start?: (call: Call) => Response;
    refund?: () => Response;
    site?: Handler;
  }): Handler {
    return (call) => {
      if (
        ["localhost", "127.0.0.1", "[::1]"].includes(new URL(call.url).hostname)
      )
        return (overrides.site ?? site())(call);
      if (call.url === `${SBX_API}/external/v1/products/${PRODUCT_ID}`)
        return json({
          ...product,
          ...(overrides.accessUrl ? { access_url: overrides.accessUrl } : {}),
        });
      if (call.url === start)
        return (
          overrides.start?.(call) ??
          json({
            status: "completed",
            handoff_code: HANDOFF_CODE,
            expires_in: 60,
          })
        );
      if (call.url === refund)
        return (
          overrides.refund?.() ?? json({ status: "refunded", refund_count: 1 })
        );
      if (call.url.endsWith("/account")) return json(account("sandbox"));
      return json({}, 404);
    };
  }
  const args = [
    "test-purchase",
    "--product",
    PRODUCT_ID,
    "--site-origin",
    SITE,
    "--json",
  ];

  beforeEach(async () => {
    await sandboxFirst();
    await saveCredential("sandbox");
  });

  it("入場と未購入のリダイレクトを確かめて返金し、結果と案内だけを出す。コードもCookieも出さない", async () => {
    const t = cli(api({}));
    const { code, out, err } = await t.run(...args);
    expect(code).toBe(0);
    const data = t.parsed().data;
    expect(data).toMatchObject({
      profile: "sandbox",
      product_id: PRODUCT_ID,
      site_origin: SITE,
      entered: true,
      redirected_when_unpurchased: true,
      refunded: true,
      refund_count: 1,
    });
    // 利用者への1通の案内（V-22）。
    for (const text of [
      "ご自身でも購入から入場まで試せます",
      "4242 4242 4242 4242",
      "ログイン用のメールアドレス",
      "メールに届くコード",
      "login --profile production",
      "login --complete --profile production",
      SITE,
      // 本番へ進む前に、利用者の許可を取る。
      "サンドボックスで確認できたので、本番を導入してよいですか？",
      "返事を待",
    ])
      expect(data.next_step).toContain(text);
    // 許可を聞く前に本番のログインを始めない（承認URLを先に渡さない）。
    const step = String(data.next_step);
    expect(step.indexOf("本番を導入してよいですか")).toBeLessThan(
      step.indexOf("login --profile production"),
    );
    expect(step).not.toContain("先に `npx cozeni login --profile production");
    for (const secret of [HANDOFF_CODE, CUSTOMER_COOKIE, sandboxKey]) {
      expect(out).not.toContain(secret);
      expect(err).not.toContain(secret);
    }
  });
  it("限定ページ（access_urlのパス）に ?cozeni_code= を付けて要求し、Cookie で入り、Cookie なしで確かめ、最後に返金する", async () => {
    const t = cli(api({}));
    await t.run(...args);
    const sequence = t.calls.map((call) =>
      call.url.startsWith(SITE)
        ? `${call.method} ${new URL(call.url).pathname}${
            new URL(call.url).searchParams.has("cozeni_code") ? "?code" : ""
          } cookie=${call.headers.has("Cookie")}`
        : `${call.method} ${call.url.replace(`${SBX_API}/external/v1`, "")}`,
    );
    expect(sequence).toEqual([
      `GET /products/${PRODUCT_ID}`,
      `POST /products/${PRODUCT_ID}/test-purchase`,
      "GET /members/handbook?code cookie=false",
      "GET /members/handbook cookie=true",
      "GET /members/handbook cookie=false",
      `POST /products/${PRODUCT_ID}/test-purchase/refund`,
    ]);
    const site = t.calls.filter((call) => call.url.startsWith(SITE));
    // リダイレクトは自分で辿る（Cookie を別の場所へ送らない）。
    expect(site.every((call) => call.url.startsWith(SITE))).toBe(true);
    expect(
      t.calls
        .filter((call) => !call.url.startsWith(SITE))
        .some((call) => call.url.includes(HANDOFF_CODE)),
    ).toBe(false);
  });
  it("202のあいだ、login --complete と同じ間隔で打ち直し、completedで進む", async () => {
    let attempts = 0;
    const t = cli(
      api({
        start: () =>
          ++attempts < 3
            ? json({ status: "pending" }, 202)
            : json({
                status: "completed",
                handoff_code: HANDOFF_CODE,
                expires_in: 60,
              }),
      }),
    );
    expect((await t.run(...args)).code).toBe(0);
    const starts = t.calls.filter((call) => call.url === start);
    expect(starts).toHaveLength(3);
    expect((starts[1]?.now ?? 0) - (starts[0]?.now ?? 0)).toBe(5000);
  });
  it("90秒たっても購入権ができなければ、終了コード6で戻り、返金も入場の確認もしない", async () => {
    const t = cli(api({ start: () => json({ status: "pending" }, 202) }));
    const { code } = await t.run(...args);
    expect(code).toBe(6);
    expect(t.parsed().error.code).toBe("authorization_pending");
    expect(t.parsed().error.hint).toContain("打ち直して");
    expect(t.state.now - START).toBeLessThanOrEqual(90_000);
    expect(t.calls.some((call) => call.url.startsWith(SITE))).toBe(false);
    expect(t.calls.some((call) => call.url === refund)).toBe(false);
  });
  it("本番プロファイルでは通信せずに止まる", async () => {
    await saveCredential("production");
    const t = cli(() => json({}, 500));
    const { code } = await t.run(...args, "--profile", "production");
    expect(code).toBe(2);
    expect(t.parsed().error.code).toBe("test_purchase_unavailable");
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it.each([
    "https://example.com",
    "http://192.168.0.5:3000",
    "http://localhost.example.com",
    "https://localhost.evil.test",
  ])(
    "ループバック以外の --site-origin（%s）では通信せずに止まる",
    async (origin) => {
      const t = cli(() => json({}, 500));
      const { code } = await t.run(
        "test-purchase",
        "--product",
        PRODUCT_ID,
        "--site-origin",
        origin,
        "--json",
      );
      expect(code).toBe(2);
      expect(t.parsed().error.code).toBe("site_origin_not_allowed");
      expect(t.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["http://127.0.0.1:3000", "http://[::1]:3000"])(
    "ループバック（%s）は受け付ける",
    async (origin) => {
      const t = cli(
        api({
          site: ({ url, headers }) => {
            const target = new URL(url);
            if (target.searchParams.has("cozeni_code"))
              return new Response(null, {
                status: 303,
                headers: {
                  Location: target.pathname,
                  "Set-Cookie": "cozeni_customer=x; Path=/",
                },
              });
            return headers.has("Cookie")
              ? new Response("ok")
              : new Response(null, {
                  status: 307,
                  headers: { Location: enterUrl },
                });
          },
        }),
      );
      const { code } = await t.run(
        "test-purchase",
        "--product",
        PRODUCT_ID,
        "--site-origin",
        origin,
        "--json",
      );
      // 相対 Location を、同じオリジンの開発サーバーとして辿れる。
      expect(code).toBe(0);
    },
  );
  it("--product と --site-origin は必須", async () => {
    const t = cli(() => json({}, 500));
    expect((await t.run("test-purchase", "--json")).code).toBe(2);
    expect(
      (await t.run("test-purchase", "--product", PRODUCT_ID, "--json")).code,
    ).toBe(2);
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it("未購入でも限定ページが開いてしまうなら、入場画面へ送られていないと報告し、返金しない", async () => {
    const t = cli(api({ site: site({ open: true }) }));
    const { code, out } = await t.run(...args);
    expect(code).toBe(4);
    expect(t.parsed().error).toMatchObject({
      code: "entry_check_failed",
      entered: true,
      redirected_when_unpurchased: false,
      refunded: false,
      reason: "not_redirected",
    });
    expect(t.calls.some((call) => call.url === refund)).toBe(false);
    expect(out).not.toContain(HANDOFF_CODE);
  });
  it.each([
    [
      "本番の購入者面",
      `https://checkout.cozeni.net/enter?product_id=${PRODUCT_ID}`,
    ],
    ["サンドボックスの管理画面", `${SBX_APP}/enter?product_id=${PRODUCT_ID}`],
  ])(
    "未購入のとき%sの入場画面へ送られたら、別の環境と報告し、返金しない",
    async (_label, enter) => {
      const t = cli(api({ site: site({ enter }) }));
      const { code } = await t.run(...args);
      expect(code).toBe(4);
      expect(t.parsed().error).toMatchObject({
        code: "entry_check_failed",
        entered: true,
        redirected_when_unpurchased: false,
        refunded: false,
        reason: "enter_url_other_environment",
      });
      // 実際の転送先と期待したオリジンを示す。
      const { hint } = t.parsed().error;
      expect(hint).toContain(`${new URL(enter).origin}/enter`);
      expect(hint).toContain(`${SBX_CHECKOUT}/enter`);
      expect(hint).toContain("proxy");
      expect(hint).toContain("購入リンク");
      expect(t.calls.some((call) => call.url === refund)).toBe(false);
    },
  );
  it("サイトがコードを処理しなければ、proxy の確認を案内し、返金しない", async () => {
    const t = cli(api({ site: site({ codeIgnored: true }) }));
    const { code } = await t.run(...args);
    expect(code).toBe(4);
    expect(t.parsed().error).toMatchObject({
      code: "entry_check_failed",
      entered: false,
      reason: "handoff_not_handled",
    });
    expect(t.parsed().error.hint).toContain("proxy");
    expect(t.calls.some((call) => call.url === refund)).toBe(false);
  });
  it("権利が付かなければ、印付きの200の拒否表示を「入れた」と誤判定せず、返金しない", async () => {
    const t = cli(api({ site: site({ noGrant: true }) }));
    const { code } = await t.run(...args);
    expect(code).toBe(4);
    expect(t.parsed().error).toMatchObject({
      code: "entry_check_failed",
      entered: false,
      reason: "redirected_away",
    });
    // 確認の要求に、停止用の印を付けない。
    const checks = t.calls.filter((call) => call.url.startsWith(SITE));
    expect(checks[1]?.headers.get("Cookie") ?? "").not.toContain(
      "cozeni_handoff",
    );
    expect(t.calls.some((call) => call.url === refund)).toBe(false);
  });
  it("コードを交換できなければ COZENI_ENVIRONMENT を案内する", async () => {
    const t = cli(api({ site: site({ handoff: "invalid_code" }) }));
    const { code } = await t.run(...args);
    expect(code).toBe(4);
    expect(t.parsed().error.reason).toBe("invalid_code");
    expect(t.parsed().error.hint).toContain("COZENI_ENVIRONMENT=sandbox");
  });
  it("開発サーバーに届かなければ、コードを含めずに案内する", async () => {
    const t = cli(
      api({
        site: ({ url }) => {
          throw new Error(`connect ECONNREFUSED ${url}`);
        },
      }),
    );
    const { code, out, err } = await t.run(...args);
    expect(code).toBe(5);
    expect(t.parsed().error.code).toBe("site_unreachable");
    expect(out + err).not.toContain(HANDOFF_CODE);
    expect(t.calls.some((call) => call.url === refund)).toBe(false);
  });
  it("コード付きURLを手元の外へリダイレクトされても追わない", async () => {
    const t = cli(
      api({
        site: ({ url }) =>
          url.includes("cozeni_code")
            ? new Response(null, {
                status: 303,
                headers: { Location: "https://evil.example/steal" },
              })
            : json({}, 404),
      }),
    );
    const { code } = await t.run(...args);
    expect(code).toBe(4);
    expect(t.calls.some((call) => call.url.startsWith("https://evil"))).toBe(
      false,
    );
  });
  it("409 creator_not_ready は blockers の案内（Stripe 連携の依頼と待ち方）を hint に出す", async () => {
    const t = cli(
      api({
        start: () =>
          apiError("creator_not_ready", 409, {
            blockers: [
              {
                code: "stripe_onboarding_incomplete",
                action_url: `${SBX_APP}/settings/stripe`,
              },
            ],
          }),
      }),
    );
    const { code } = await t.run(...args);
    expect(code).toBe(4);
    const error = t.parsed().error;
    expect(error.code).toBe("creator_not_ready");
    expect(error.hint).toContain("テスト用の Stripe 連携");
    expect(error.hint).toContain("000-000");
    expect(error.hint).toContain(`${SBX_APP}/settings/stripe`);
    expect(error.hint).toContain("status");
    expect(t.calls.some((call) => call.url.startsWith(SITE))).toBe(false);
  });
  it("サンドボックス以外のサーバー（404 not_found）は、サンドボックス専用と案内する", async () => {
    const t = cli(api({ start: () => apiError("not_found", 404) }));
    const { code } = await t.run(...args);
    expect(code).toBe(4);
    expect(t.parsed().error.message).toContain("サンドボックス専用");
  });
  it("他人の商品は not_found", async () => {
    const t = cli((call) =>
      call.url.endsWith(`/products/${PRODUCT_ID}`)
        ? apiError("product_not_found", 404)
        : json(account("sandbox")),
    );
    expect((await t.run(...args)).code).toBe(4);
    expect(t.parsed().error.code).toBe("not_found");
  });
  it("502 stripe_error は打ち直しを案内する", async () => {
    const t = cli(api({ start: () => apiError("stripe_error", 502) }));
    const { code } = await t.run(...args);
    expect(code).toBe(5);
    expect(t.parsed().error.hint).toContain("打ち直して");
  });
  it("返金に失敗したら、確認は済んでいること・打ち直せることを示す。打ち直しは既存の購入権から確認して返金する", async () => {
    let refunds = 0;
    const t = cli(
      api({
        refund: () =>
          ++refunds === 1
            ? apiError("stripe_error", 502)
            : json({ status: "refunded", refund_count: 1 }),
      }),
    );
    const first = await t.run(...args);
    expect(first.code).toBe(5);
    expect(t.parsed().error).toMatchObject({
      entered: true,
      redirected_when_unpurchased: true,
      refunded: false,
    });
    expect(t.parsed().error.hint).toContain("打ち直す");
    const second = await t.run(...args);
    expect(second.code).toBe(0);
    expect(t.parsed().data.refunded).toBe(true);
    // 開始の応答は completed（決済せず確認だけ）。決済の新規作成は開始 API が判断する。
    expect(t.calls.filter((call) => call.url === start)).toHaveLength(2);
  });
  it("返金の対象がなければ（返金済みの打ち直し）、失敗せず返金していないと示す", async () => {
    const t = cli(
      api({
        refund: () => json({ status: "nothing_to_refund", refund_count: 0 }),
      }),
    );
    expect((await t.run(...args)).code).toBe(0);
    expect(t.parsed().data).toMatchObject({ refunded: false, refund_count: 0 });
  });

  describe("外部レビューの指摘", () => {
    it("access_url のパスが // で始まっても、--site-origin の外へ送らない", async () => {
      const t = cli(
        api({ accessUrl: "https://site.example//evil.example/steal" }),
      );
      await t.run(...args);
      expect(
        t.calls.some((call) => new URL(call.url).hostname === "evil.example"),
      ).toBe(false);
      const first = t.calls.find((call) => call.url.includes("cozeni_code"));
      expect(new URL(first?.url ?? "").origin).toBe(SITE);
    });
    it("コード付きの要求が /login へ 302・303 で転送されても、入れたことにしない", async () => {
      for (const status of [302, 303]) {
        const t = cli(
          api({
            site: ({ url }) => {
              if (url.includes("cozeni_code")) {
                const r = new Response(null, {
                  status,
                  headers: { Location: `${SITE}/login` },
                });
                r.headers.append(
                  "Set-Cookie",
                  `cozeni_customer=${CUSTOMER_COOKIE}; Path=/`,
                );
                return r;
              }
              return url.endsWith("/login")
                ? new Response("login", { status: 200 })
                : new Response(null, {
                    status: 307,
                    headers: { Location: enterUrl },
                  });
            },
          }),
        );
        const { code } = await t.run(...args);
        expect(code).toBe(4);
        expect(t.parsed().error).toMatchObject({
          code: "entry_check_failed",
          reason: "unexpected_redirect",
        });
        expect(t.calls.some((call) => call.url === refund)).toBe(false);
      }
    });
    it("購入者の Cookie が付かなければ、入れたことにしない", async () => {
      const t = cli(
        api({
          site: ({ url }) =>
            url.includes("cozeni_code")
              ? new Response(null, {
                  status: 303,
                  headers: { Location: `${SITE}/members/handbook` },
                })
              : new Response("公開ページ", { status: 200 }),
        }),
      );
      expect((await t.run(...args)).code).toBe(4);
      expect(t.parsed().error.reason).toBe("no_customer_cookie");
    });
    it("別のホストへ戻されたら Cookie を送らず、ホストを揃えるよう案内する", async () => {
      const t = cli(
        api({
          site: ({ url }) => {
            if (!url.includes("cozeni_code"))
              return new Response("x", { status: 200 });
            const r = new Response(null, {
              status: 303,
              headers: { Location: "http://localhost:3000/members/handbook" },
            });
            r.headers.append(
              "Set-Cookie",
              `cozeni_customer=${CUSTOMER_COOKIE}; Path=/`,
            );
            return r;
          },
        }),
      );
      const { code } = await t.run(
        "test-purchase",
        "--product",
        PRODUCT_ID,
        "--site-origin",
        "http://127.0.0.1:3000",
        "--json",
      );
      expect(code).toBe(4);
      expect(t.parsed().error.reason).toBe("host_mismatch");
      expect(t.parsed().error.hint).toContain("localhost");
      expect(
        t.calls.some((call) => new URL(call.url).hostname === "localhost"),
      ).toBe(false);
      expect(
        t.calls.some((call) =>
          call.headers.get("Cookie")?.includes(CUSTOMER_COOKIE),
        ),
      ).toBe(false);
    });
    it("サンドボックスだけの導入（過去の本番の期待値が残っている）では、本番への案内を出さない", async () => {
      await store().saveConfig({
        version: 1,
        default_profile: "sandbox",
        flow: "sandbox-only",
        profiles: {
          production: { expected_creator_id: "cre_1" },
          sandbox: { expected_creator_id: "cre_1" },
        },
      });
      const t = cli(api({}));
      expect((await t.run(...args)).code).toBe(0);
      const step = t.parsed().data.next_step as string;
      expect(step).not.toContain("login --profile production");
      expect(step).not.toContain("login --complete --profile production");
      expect(step).toContain("ご自身でも購入から入場まで試せます");
      expect(step).toContain("本番の管理画面の導入プロンプト");
    });
    it("接続先が本番の API なら、別名のプロファイルからも送らない", async () => {
      await store().saveConfig({
        version: 1,
        default_profile: "alias",
        profiles: { alias: { api_origin: PROD_API, app_origin: PROD_APP } },
      });
      await store().saveCredential("alias", {
        api_origin: PROD_API,
        app_origin: PROD_APP,
        api_key: productionKey,
        key_id: "k",
        creator_id: "cre_1",
        environment: "production",
        expires_at: "2026-11-05T00:00:00.000Z",
      });
      const t = cli(api({}));
      const { code } = await t.run(...args);
      expect(code).toBe(2);
      expect(t.parsed().error.code).toBe("test_purchase_unavailable");
      expect(t.fetch).not.toHaveBeenCalled();
    });
    it("最長90秒を超えて要求を送らず、期限での打ち切りは終了コード6", async () => {
      let t!: ReturnType<typeof cli>;
      t = cli(
        api({
          start: () => {
            t.state.now += 40_000; // 1回の要求が長引く
            return json({ status: "pending" }, 202);
          },
        }),
      );
      const { code } = await t.run(...args);
      expect(code).toBe(6);
      expect(t.calls.filter((call) => call.url === start).length).toBe(2);
      expect(t.state.now - START).toBeLessThanOrEqual(95_000);
    });
  });

  describe("再レビューの指摘", () => {
    it.each([
      ["+ に正規化して戻す", "/members?q=a+b"],
      ["元の表記のまま戻す", "/members?q=a%20b"],
    ])(
      "クエリ付きの限定ページでも、サイトが%sなら入れたと判定して返金する",
      async (_, back) => {
        const t = cli(
          api({
            accessUrl: "https://site.example/members?q=a%20b",
            site: ({ url, headers }) => {
              if (url.includes("cozeni_code")) {
                const r = new Response(null, {
                  status: 303,
                  headers: { Location: `${SITE}${back}` },
                });
                r.headers.append(
                  "Set-Cookie",
                  `cozeni_customer=${CUSTOMER_COOKIE}; Path=/`,
                );
                return r;
              }
              return headers.has("Cookie")
                ? new Response("ok", { status: 200 })
                : new Response(null, {
                    status: 307,
                    headers: { Location: enterUrl },
                  });
            },
          }),
        );
        expect((await t.run(...args)).code).toBe(0);
        expect(t.calls.some((call) => call.url === refund)).toBe(true);
        const again = t.calls.filter(
          (call) =>
            call.url.startsWith(SITE) && !call.url.includes("cozeni_code"),
        )[0];
        expect(new URL(again?.url ?? "").searchParams.get("q")).toBe("a b");
      },
    );
    it("期限で打ち切ったタイムアウトは 6、即時の通信失敗は 5", async () => {
      // 即時の通信失敗（残りは30秒以下）。
      let a!: ReturnType<typeof cli>;
      let calls = 0;
      a = cli(
        api({
          start: () => {
            if (++calls === 1) {
              a.state.now += 60_000;
              return json({ status: "pending" }, 202);
            }
            throw new Error("ECONNREFUSED");
          },
        }),
      );
      expect((await a.run(...args)).code).toBe(5);
      // 期限に達したタイムアウト（残り1秒で打ち切られる）。
      let b!: ReturnType<typeof cli>;
      let n = 0;
      b = cli((call) => {
        if (call.url === start && ++n === 1) {
          b.state.now += 84_000;
          return json({ status: "pending" }, 202);
        }
        if (call.url === start)
          return new Promise<Response>((_, reject) =>
            call.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          ) as unknown as Response;
        return api({})(call);
      });
      expect((await b.run(...args)).code).toBe(6);
    });
    it("本番を指す別名のプロファイルは、通信する前（verifyCreator より先）に止める", async () => {
      await store().saveConfig({
        version: 1,
        default_profile: "alias",
        profiles: {
          alias: {
            api_origin: PROD_API,
            app_origin: PROD_APP,
            expected_creator_id: "cre_1",
          },
        },
      });
      const t = cli(api({}), { COZENI_API_KEY: productionKey });
      expect((await t.run(...args)).code).toBe(2);
      expect(t.fetch).not.toHaveBeenCalled();
    });
  });

  it("人向けの表示にもコードとCookieを出さない", async () => {
    const t = cli(api({}));
    const { code, out, err } = await t.run(
      "test-purchase",
      "--product",
      PRODUCT_ID,
      "--site-origin",
      SITE,
    );
    expect(code).toBe(0);
    expect(out).toContain("テスト購入が通りました");
    expect(out + err).not.toContain(HANDOFF_CODE);
    expect(out + err).not.toContain(CUSTOMER_COOKIE);
  });
});

describe("skill の版", () => {
  it("同梱のskillの対応版にこの版が含まれ、test-purchase と switch を案内している", async () => {
    const skill = await readFile(
      new URL("../skills/cozeni-setup/SKILL.md", import.meta.url),
      "utf8",
    );
    const { version } = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    const { satisfies, skillRange } = await import(
      "../src/cli/skill-version.js"
    );
    expect(satisfies(version, skillRange(skill) ?? "")).toBe(true);
    expect(skill).toContain("test-purchase");
    expect(skill).toContain("switch");
  });
});
