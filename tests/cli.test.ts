import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliContext, run } from "../src/cli/run.js";
import { satisfies, skillRange } from "../src/cli/skill-version.js";
import { createStore } from "../src/cli/store.js";

const API = "https://api.cozeni.net";
const APP = "https://app.cozeni.net";
const START = Date.parse("2026-09-25T00:00:00.000Z");
const version = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version as string;

type Handler = (call: {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
  now: number;
}) => Response | Promise<Response>;
const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers });
const apiError = (code: string, status: number) =>
  json({ error: { code, message: code, request_id: "req_test" } }, status);

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cozeni-cli-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function cli(
  handler: Handler,
  options: {
    env?: Record<string, string>;
    tty?: boolean;
    answer?: string;
  } = {},
) {
  const state = { now: START };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: {
    method: string;
    path: string;
    body: unknown;
    headers: Headers;
    now: number;
    init: RequestInit;
  }[] = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const call = {
        method: init?.method ?? "GET",
        path: `${url.origin}${url.pathname}${url.search}`,
        body,
        headers,
        now: state.now,
      };
      calls.push({ ...call, init: init ?? {} });
      return handler(call);
    },
  );
  const lineListeners: (() => void)[] = [];
  const openBrowser = vi.fn();
  const prompt = vi.fn(async () => options.answer ?? "n");
  const context = (argv: string[]): CliContext => ({
    argv,
    env: { XDG_CONFIG_HOME: home, HOME: home, ...options.env },
    cwd: home,
    stdout: { write: (text) => void stdout.push(text) },
    stderr: { write: (text) => void stderr.push(text) },
    interactiveTerminal: options.tty ?? false,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => state.now,
    sleep: async (ms) => {
      state.now += ms;
    },
    openBrowser,
    prompt,
    onLine: (listener) => {
      lineListeners.push(listener);
      return () => {};
    },
    runCommand: async () => {
      throw new Error("このテストでは子プロセスを起動しない");
    },
  });
  return {
    state,
    calls,
    fetch,
    openBrowser,
    prompt,
    lineListeners,
    stdout,
    stderr,
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

const deviceCode = {
  device_code: "dev_secret_code_value",
  user_code: "BCDF-GHJK",
  verification_uri: `${APP}/device`,
  verification_uri_complete: `${APP}/device?code=BCDF-GHJK`,
  expires_in: 600,
  interval: 5,
};
const token = {
  api_key: "cozeni_cli_new_secret",
  key_id: "key_new",
  creator_id: "crt_1",
  environment: "production",
  expires_at: "2026-10-25T00:00:00.000Z",
};
const account = {
  creator_id: "crt_1",
  api_key_id: "key_new",
  scopes: [
    "products:read",
    "products:write",
    "checkout_links:read",
    "checkout_links:write",
  ],
  environment: "production",
  api_version: "v1",
  sales: {
    can_sell: false,
    blockers: [
      { code: "review_not_submitted", action_url: `${APP}/settings/review` },
    ],
    warnings: [],
  },
};
const product = {
  id: "prd_1",
  name: "ハンドブック",
  price_jpy: 1000,
  access_url: "https://site.example/members",
  currency: "jpy",
  status: "active",
  created_at: "2026-09-25T00:00:00.000Z",
  updated_at: "2026-09-25T00:00:00.000Z",
};
const link = {
  id: "lnk_1",
  product_id: "prd_1",
  url: `${APP}/checkout/abcd`,
  disabled: false,
};

async function saveLogin(
  overrides: Partial<typeof token> & { api_origin?: string } = {},
  profile = "production",
) {
  await createStore({ XDG_CONFIG_HOME: home }).saveCredential(profile, {
    api_origin: API,
    app_origin: APP,
    api_key: token.api_key,
    key_id: token.key_id,
    creator_id: token.creator_id,
    environment: token.environment,
    expires_at: token.expires_at,
    ...overrides,
  });
}

describe("login（2段階）", () => {
  it("非対話ではデバイスコードを出してすぐ終了し、待ち状態を0600で保存する", async () => {
    const t = cli(() => json(deviceCode), { env: { CLAUDECODE: "1" } });
    const { code } = await t.run("login", "--json");
    expect(code).toBe(0);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.path).toBe(`${API}/external/v1/cli/device-codes`);
    expect(t.calls[0]?.body).toEqual({
      cli_version: version,
      client_name: "Claude Code",
    });
    const output = t.parsed();
    expect(output).toEqual({
      ok: true,
      data: {
        verification_uri: `${APP}/device`,
        verification_uri_complete: `${APP}/device?code=BCDF-GHJK`,
        user_code: "BCDF-GHJK",
        expires_at: "2026-09-25T00:10:00.000Z",
        next_step: "npx @nulogic/cozeni-sdk login --complete",
      },
    });
    // デバイスコードは出力しない。
    expect(JSON.stringify(output)).not.toContain(deviceCode.device_code);
    const pending = join(home, "cozeni", "pending", "login-production.json");
    expect((await lstat(pending)).mode & 0o777).toBe(0o600);
  });
  it("期限内に再実行したら同じコードを出し直し、二重に発行しない", async () => {
    const t = cli(() => json(deviceCode));
    await t.run("login", "--json");
    t.state.now += 60_000;
    await t.run("login", "--json");
    expect(t.calls).toHaveLength(1);
    expect(t.parsed().data.user_code).toBe("BCDF-GHJK");
  });
  it("管理画面オリジンと一致しない承認URLは表示しない", async () => {
    const t = cli(() =>
      json({
        ...deviceCode,
        verification_uri: "https://phish.example/device",
      }),
    );
    const { code, out } = await t.run("login", "--json");
    expect(code).toBe(1);
    expect(out).not.toContain("phish.example");
    expect(t.parsed().error.code).toBe("invalid_response");
  });
  it("コード付きURLだけが不一致なら、それだけを落とす", async () => {
    const t = cli(() =>
      json({
        ...deviceCode,
        verification_uri_complete: "http://app.cozeni.net/device?code=X",
      }),
    );
    await t.run("login", "--json");
    const data = t.parsed().data;
    expect(data.verification_uri).toBe(`${APP}/device`);
    expect(data).not.toHaveProperty("verification_uri_complete");
  });
  it("--completeは承認前なら最長90秒ポーリングして終了コード6で戻る", async () => {
    const t = cli(({ path }) =>
      path.endsWith("/cli/device-codes")
        ? json(deviceCode)
        : json({ error: "authorization_pending" }, 400),
    );
    await t.run("login", "--json");
    const { code } = await t.run("login", "--complete", "--json");
    expect(code).toBe(6);
    expect(t.parsed().error.code).toBe("authorization_pending");
    const polls = t.calls.filter((call) => call.path.endsWith("/cli/tokens"));
    expect(polls.length).toBeGreaterThanOrEqual(18);
    expect(polls.length).toBeLessThanOrEqual(19);
    expect(polls[0]?.body).toEqual({ device_code: deviceCode.device_code });
    expect(t.state.now - START).toBeLessThanOrEqual(90_000);
  });
  it("--completeは応答が返らなくても90秒を超えて止まらない", async () => {
    let polls = 0;
    const t = cli(() => json({}));
    t.fetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/cli/device-codes")) return json(deviceCode);
      polls += 1;
      if (polls === 1) {
        // 1回目の応答までに、期限の直前まで時間が経ったとみなす。
        t.state.now += 89_990;
        return apiError("authorization_pending", 400);
      }
      // 2回目は応答が返らない。要求のタイムアウトが残り時間に制限されていれば中断される。
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    });
    await t.run("login", "--json");
    const started = Date.now();
    const { code } = await t.run("login", "--complete", "--json");
    expect(code).toBe(6);
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("slow_downで以後の間隔を5秒延ばす", async () => {
    let count = 0;
    const t = cli(({ path }) => {
      if (path.endsWith("/cli/device-codes")) return json(deviceCode);
      count += 1;
      if (count === 1) return apiError("slow_down", 400);
      if (count === 2) return apiError("authorization_pending", 400);
      return json(token);
    });
    await t.run("login", "--json");
    await t.run("login", "--complete", "--json");
    const polls = t.calls.filter((call) => call.path.endsWith("/cli/tokens"));
    expect(polls.map((call) => call.now - START)).toEqual([0, 10_000, 20_000]);
  });
  it.each([
    ["access_denied", 3],
    ["expired_token", 3],
  ])("%sなら待ち状態を消して終了コード%sで戻る", async (error, exit) => {
    const t = cli(({ path }) =>
      path.endsWith("/cli/device-codes")
        ? json(deviceCode)
        : apiError(error, 400),
    );
    await t.run("login", "--json");
    expect((await t.run("login", "--complete", "--json")).code).toBe(exit);
    expect(t.parsed().error.code).toBe(error);
    await expect(
      lstat(join(home, "cozeni", "pending", "login-production.json")),
    ).rejects.toThrow();
  });
  it("成功したらキーを保存し、保存後に前のキーをログアウトさせる", async () => {
    await saveLogin({ api_key: "cozeni_cli_old_secret", key_id: "key_old" });
    const store = createStore({ XDG_CONFIG_HOME: home });
    let savedAtLogout: string | undefined;
    const t = cli(async ({ path, headers }) => {
      if (path.endsWith("/cli/device-codes")) return json(deviceCode);
      if (path.endsWith("/cli/tokens")) return json(token);
      if (path.endsWith("/cli/logout")) {
        savedAtLogout = (await store.loadCredential("production"))?.api_key;
        expect(headers.get("Authorization")).toBe(
          "Bearer cozeni_cli_old_secret",
        );
        return new Response(null, { status: 204 });
      }
      return json({}, 404);
    });
    await t.run("login", "--json");
    const { code, out, err } = await t.run("login", "--complete", "--json");
    expect(code).toBe(0);
    expect(savedAtLogout).toBe(token.api_key);
    const data = t.parsed().data;
    expect(data).toMatchObject({
      key_id: "key_new",
      creator_id: "crt_1",
      expires_at: token.expires_at,
    });
    expect(out + err).not.toContain(token.api_key);
    expect(
      (await lstat(join(home, "cozeni", "credentials.json"))).mode & 0o777,
    ).toBe(0o600);
    await expect(
      lstat(join(home, "cozeni", "pending", "login-production.json")),
    ).rejects.toThrow();
  });
  it("前のキーの失効に失敗しても、ログインは成功として警告だけ出す", async () => {
    await saveLogin({ api_key: "cozeni_cli_old_secret" });
    const t = cli(({ path }) => {
      if (path.endsWith("/cli/device-codes")) return json(deviceCode);
      if (path.endsWith("/cli/tokens")) return json(token);
      throw new TypeError("fetch failed");
    });
    await t.run("login", "--json");
    const { code } = await t.run("login", "--complete", "--json");
    expect(code).toBe(0);
    expect(t.parsed().data.warnings).toEqual(["previous_key_not_revoked"]);
  });
  it("COZENI_API_KEYが設定されていれば、保存したキーより優先されると警告する", async () => {
    const t = cli(
      ({ path }) =>
        path.endsWith("/cli/device-codes") ? json(deviceCode) : json(token),
      { env: { COZENI_API_KEY: "cozeni_env_secret" } },
    );
    await t.run("login", "--json");
    expect((await t.run("login", "--complete", "--json")).code).toBe(0);
    expect(t.parsed().data.warnings).toEqual(["env_key_takes_precedence"]);
  });
  it("待ち状態が無ければログインから始めるよう案内する", async () => {
    const t = cli(() => json({}));
    expect((await t.run("login", "--complete", "--json")).code).toBe(3);
    expect(t.parsed().error).toMatchObject({
      code: "login_required",
      hint: expect.stringContaining("npx @nulogic/cozeni-sdk login"),
    });
    expect(t.calls).toHaveLength(0);
  });
  it("TTYでは1段階でコードを出して承認を待ち、Enterでブラウザを開く", async () => {
    let polls = 0;
    const t = cli(
      ({ path }) => {
        if (path.endsWith("/cli/device-codes")) return json(deviceCode);
        polls += 1;
        if (polls === 1) {
          for (const listener of t.lineListeners) listener();
          return apiError("authorization_pending", 400);
        }
        return json(token);
      },
      { tty: true },
    );
    const { code, out } = await t.run("login");
    expect(code).toBe(0);
    expect(out).toContain("BCDF-GHJK");
    expect(out).toContain("2026-10-25");
    expect(out).toContain("平文");
    expect(t.openBrowser).toHaveBeenCalledWith(`${APP}/device?code=BCDF-GHJK`);
  });
  it("AIの実行環境ではTTYでも2段階で動く", async () => {
    const t = cli(() => json(deviceCode), {
      tty: true,
      env: { CODEX_SANDBOX: "seatbelt" },
    });
    const { code, out } = await t.run("login");
    expect(code).toBe(0);
    expect(out).toContain("login --complete");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.body).toMatchObject({ client_name: "Codex" });
  });
});

describe("接続先の固定", () => {
  it("productionでは接続先の上書きを受け付けない", async () => {
    const t = cli(() => json(deviceCode));
    expect(
      (await t.run("login", "--api-origin", "https://evil.example", "--json"))
        .code,
    ).toBe(2);
    const env = cli(() => json(deviceCode), {
      env: { COZENI_API_ORIGIN: "https://evil.example" },
    });
    expect((await env.run("login", "--json")).code).toBe(2);
    expect(t.calls.length + env.calls.length).toBe(0);
  });
  it("production以外のプロファイルは上書きでき、保存済みキーと違えば送らない", async () => {
    await saveLogin(
      { api_origin: "http://localhost:8787", environment: "development" },
      "dev",
    );
    const t = cli(() => json(account));
    const { code } = await t.run(
      "whoami",
      "--profile",
      "dev",
      "--api-origin",
      "http://127.0.0.1:9999",
      "--json",
    );
    expect(code).toBe(2);
    expect(t.parsed().error.code).toBe("origin_mismatch");
    expect(t.calls).toHaveLength(0);
    await t.run("whoami", "--profile", "dev", "--json");
    expect(t.calls[0]?.path).toBe("http://localhost:8787/external/v1/account");
  });
  it("キー付き要求はリダイレクトを追わずにエラーにする", async () => {
    await saveLogin();
    const t = cli(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example" },
        }),
    );
    expect((await t.run("whoami", "--json")).code).toBe(5);
    expect(t.parsed().error.code).toBe("unexpected_redirect");
    expect(t.calls[0]?.init.redirect).toBe("manual");
  });
});

describe("認証とエラーの案内", () => {
  it("COZENI_API_KEYを保存済みの認証情報より優先する", async () => {
    await saveLogin();
    const t = cli(() => json(account), {
      env: { COZENI_API_KEY: "cozeni_env_secret" },
    });
    expect((await t.run("whoami", "--json")).code).toBe(0);
    expect(t.calls[0]?.headers.get("Authorization")).toBe(
      "Bearer cozeni_env_secret",
    );
    expect(t.parsed().data).toMatchObject({
      key_source: "env",
      key_id: "key_new",
      creator_id: "crt_1",
      expires_at: null,
    });
  });
  it("COZENI_API_KEYがあれば、壊れた保存ファイルを読まずに使う", async () => {
    await mkdir(join(home, "cozeni"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, "cozeni", "credentials.json"), "{", {
      mode: 0o644,
    });
    const t = cli(() => json(account), {
      env: { COZENI_API_KEY: "cozeni_env_secret" },
    });
    expect((await t.run("whoami", "--json")).code).toBe(0);
    expect(t.calls[0]?.headers.get("Authorization")).toBe(
      "Bearer cozeni_env_secret",
    );
  });
  it("未ログインなら終了コード3", async () => {
    const t = cli(() => json(account));
    expect((await t.run("whoami", "--json")).code).toBe(3);
    expect(t.parsed().error.code).toBe("login_required");
  });
  it("401で手元の期限を過ぎていれば期限切れの案内を出す", async () => {
    await saveLogin({ expires_at: "2026-09-24T00:00:00.000Z" });
    const t = cli(() => apiError("unauthorized", 401));
    expect((await t.run("whoami", "--json")).code).toBe(3);
    const error = t.parsed().error;
    expect(error.code).toBe("key_expired");
    expect(error.message).toContain("30日");
    expect(error.hint).toContain("npx @nulogic/cozeni-sdk login");
  });
  it("401で期限内なら失効の可能性を案内する", async () => {
    await saveLogin();
    const t = cli(() => apiError("unauthorized", 401));
    expect((await t.run("whoami", "--json")).code).toBe(3);
    const error = t.parsed().error;
    expect(error.code).toBe("login_required");
    expect(error.message).toContain("失効");
  });
  it("規約の同意が必要なら管理画面を案内する", async () => {
    await saveLogin();
    const t = cli(() => apiError("terms_consent_required", 403));
    expect((await t.run("whoami", "--json")).code).toBe(4);
    expect(t.parsed().error.hint).toContain(APP);
  });
  it("通信できなければクラウド型ツールのネットワーク許可を案内する", async () => {
    await saveLogin();
    const t = cli(() => {
      throw new TypeError("fetch failed");
    });
    const { code } = await t.run("whoami", "--json");
    expect(code).toBe(5);
    const error = t.parsed().error;
    expect(error.code).toBe("network_unreachable");
    expect(error.message).toContain("api.cozeni.net");
    expect(error.hint).toContain("Codex cloud");
    expect(error.hint).toContain("Claude Code on the web");
  });
  it("429はRetry-After秒後の再実行を案内する", async () => {
    await saveLogin();
    const t = cli(() =>
      json(
        { error: { code: "rate_limited", message: "x", request_id: "req_1" } },
        429,
        { "Retry-After": "30" },
      ),
    );
    expect((await t.run("whoami", "--json")).code).toBe(5);
    const error = t.parsed().error;
    expect(error.code).toBe("rate_limited");
    expect(error.retry_after_seconds).toBe(30);
    expect(error.hint).toContain("30秒");
  });
  it("人向けの表示では失敗を標準エラーへ日本語で出す", async () => {
    const t = cli(() => json(account));
    const { code, out, err } = await t.run("whoami");
    expect(code).toBe(3);
    expect(out).toBe("");
    expect(err).toContain("ログイン");
  });
});

describe("logout", () => {
  it("サーバーで失効させてからローカルの認証情報を消す", async () => {
    await saveLogin();
    const t = cli(() => new Response(null, { status: 204 }));
    expect((await t.run("logout", "--json")).code).toBe(0);
    expect(t.calls[0]?.path).toBe(`${API}/external/v1/cli/logout`);
    expect(t.calls[0]?.headers.get("Authorization")).toBe(
      `Bearer ${token.api_key}`,
    );
    expect(
      await createStore({ XDG_CONFIG_HOME: home }).loadCredential("production"),
    ).toBeUndefined();
  });
  it("サーバーでの失効に失敗してもローカルは消し、警告だけ出す", async () => {
    await saveLogin();
    const t = cli(() => {
      throw new TypeError("fetch failed");
    });
    expect((await t.run("logout", "--json")).code).toBe(0);
    expect(t.parsed().data).toMatchObject({
      removed: true,
      revoked: false,
      warnings: ["server_revoke_failed"],
    });
    expect(
      await createStore({ XDG_CONFIG_HOME: home }).loadCredential("production"),
    ).toBeUndefined();
  });
  it("COZENI_API_KEYはサーバーへ送らず、環境変数から外すよう案内する", async () => {
    const t = cli(() => new Response(null, { status: 204 }), {
      env: { COZENI_API_KEY: "cozeni_env_secret" },
    });
    expect((await t.run("logout", "--json")).code).toBe(0);
    expect(t.calls).toHaveLength(0);
    expect(t.parsed().data.warnings).toContain("env_key_not_revoked");
  });
});

describe("products", () => {
  const server =
    (overrides: Partial<Record<string, Handler>> = {}): Handler =>
    (call) => {
      const key = `${call.method} ${call.path.replace(`${API}/external/v1`, "")}`;
      const custom = overrides[key];
      if (custom) return custom(call);
      if (key === "GET /account") return json(account);
      if (key === "POST /products") return json(product, 201);
      if (key === "GET /products/prd_1") return json(product);
      if (key === "PATCH /products/prd_1")
        return json({ ...product, ...(call.body as object) });
      if (key === "PUT /products/prd_1/checkout-link") return json(link);
      // 既定では商品が無い（作成の前の重複確認に掛からない）。
      if (key.startsWith("GET /products"))
        return json({ items: [], next_cursor: null });
      return json({}, 404);
    };
  const createArgs = [
    "products",
    "create",
    "--name",
    "ハンドブック",
    "--price",
    "1000",
    "--access-url",
    "https://site.example/members",
  ];

  it("作成は--yesが無ければ非TTYでconfirmation_requiredで止まる", async () => {
    await saveLogin();
    const t = cli(server());
    expect((await t.run(...createArgs, "--json")).code).toBe(2);
    expect(t.parsed().error.code).toBe("confirmation_required");
    expect(t.calls.some((call) => call.method === "POST")).toBe(false);
  });
  const idemFiles = async () =>
    (
      await import("node:fs/promises").then((fs) =>
        fs.readdir(join(home, "cozeni", "pending")).catch(() => []),
      )
    ).filter((name) => name.startsWith("idem-"));
  it("--yesで作成し、標準リンクを返す。冪等キーは成功後も残す", async () => {
    await saveLogin();
    const t = cli(server());
    expect((await t.run(...createArgs, "--yes", "--json")).code).toBe(0);
    const post = t.calls.find((call) => call.method === "POST");
    expect(post?.body).toEqual({
      name: "ハンドブック",
      price_jpy: 1000,
      access_url: "https://site.example/members",
    });
    expect(post?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.parsed().data).toMatchObject({
      product: { id: "prd_1" },
      checkout_link: { url: link.url },
      reused: false,
    });
    expect(await idemFiles()).toHaveLength(1);
  });
  it("成功後に同じ入力で打ち直しても同じ冪等キーを送り、作成済みの商品だと示す", async () => {
    await saveLogin();
    const t = cli(server());
    await t.run(...createArgs, "--yes", "--json");
    t.state.now += 60 * 60 * 1000;
    const { code, out } = await t.run(...createArgs, "--yes");
    expect(code).toBe(0);
    expect(out).toContain("作成済み");
    await t.run(...createArgs, "--yes", "--json");
    expect(t.parsed().data.reused).toBe(true);
    const keys = t.calls
      .filter((call) => call.method === "POST")
      .map((call) => call.headers.get("Idempotency-Key"));
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });
  it("24時間を過ぎた冪等キーは起動時に消す", async () => {
    await saveLogin({ expires_at: "2026-12-31T00:00:00.000Z" });
    const t = cli(server());
    await t.run(...createArgs, "--yes", "--json");
    t.state.now += 23 * 60 * 60 * 1000;
    await t.run("products", "list", "--json");
    expect(await idemFiles()).toHaveLength(1);
    t.state.now += 2 * 60 * 60 * 1000;
    await t.run("products", "list", "--json");
    expect(await idemFiles()).toHaveLength(0);
  });
  it.each(["49", "10000000", "1.5"])(
    "価格%sは確認の前にinvalid_inputにする",
    async (price) => {
      await saveLogin();
      const t = cli(server(), { tty: true, answer: "y" });
      const args = [...createArgs];
      args[5] = price;
      expect((await t.run(...args)).code).toBe(2);
      expect(t.prompt).not.toHaveBeenCalled();
      expect(t.calls).toHaveLength(0);
    },
  );
  it("タイムアウト後の再実行は同じ冪等キーを使う", async () => {
    await saveLogin();
    let first = true;
    const t = cli(
      server({
        "POST /products": () => {
          if (first) {
            first = false;
            throw new TypeError("fetch failed");
          }
          return json(product, 201);
        },
      }),
    );
    expect((await t.run(...createArgs, "--yes", "--json")).code).toBe(5);
    expect((await t.run(...createArgs, "--yes", "--json")).code).toBe(0);
    const keys = t.calls
      .filter((call) => call.method === "POST")
      .map((call) => call.headers.get("Idempotency-Key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
  it("入力が違えば別の冪等キーを使う", async () => {
    await saveLogin();
    const t = cli(
      server({ "POST /products": () => apiError("unavailable", 503) }),
    );
    await t.run(...createArgs, "--yes", "--json");
    await t.run(
      ...createArgs.slice(0, 5),
      "2000",
      ...createArgs.slice(6),
      "--yes",
      "--json",
    );
    const keys = t.calls
      .filter((call) => call.method === "POST")
      .map((call) => call.headers.get("Idempotency-Key"));
    expect(keys[0]).not.toBe(keys[1]);
  });
  it("409 idempotency_conflictは冪等キーを消さずにエラーを返す", async () => {
    await saveLogin();
    const t = cli(
      server({
        "POST /products": () => apiError("idempotency_conflict", 409),
      }),
    );
    expect((await t.run(...createArgs, "--yes", "--json")).code).toBe(4);
    await t.run(...createArgs, "--yes", "--json");
    const keys = t.calls
      .filter((call) => call.method === "POST")
      .map((call) => call.headers.get("Idempotency-Key"));
    expect(keys[0]).toBe(keys[1]);
  });
  const existing = {
    "GET /products?limit=100": () =>
      json({ items: [product], next_cursor: null }),
  };
  it("同じ名前・価格・access_urlの有効な商品があれば、確認なしで作らずにそれを返す", async () => {
    await saveLogin();
    const t = cli(
      server({
        ...existing,
        "GET /products/prd_1/checkout-link": () => json(link),
      }),
    );
    expect((await t.run(...createArgs, "--json")).code).toBe(0);
    expect(t.parsed().data).toMatchObject({
      product: { id: "prd_1" },
      checkout_link: { url: link.url },
      reused: true,
      reason: "same_product_exists",
      next_step: null,
    });
    expect(t.calls.some((call) => call.method !== "GET")).toBe(false);
  });
  it("既存の商品の購入リンクが未発行なら発行せず、linkを案内する", async () => {
    await saveLogin();
    const t = cli(
      server({
        ...existing,
        "GET /products/prd_1/checkout-link": () =>
          apiError("checkout_link_not_found", 404),
      }),
    );
    expect((await t.run(...createArgs, "--yes", "--json")).code).toBe(0);
    expect(t.parsed().data).toMatchObject({
      checkout_link: null,
      reused: true,
      next_step: "npx @nulogic/cozeni-sdk link prd_1",
    });
    expect(t.calls.some((call) => call.method !== "GET")).toBe(false);
  });
  it("アーカイブ済みや内容の違う商品は重複とみなさない", async () => {
    await saveLogin();
    const t = cli(
      server({
        "GET /products?limit=100": () =>
          json({
            items: [
              { ...product, id: "prd_a", status: "archived" },
              { ...product, id: "prd_b", price_jpy: 2000 },
              { ...product, id: "prd_c", access_url: "https://site.example/x" },
            ],
            next_cursor: null,
          }),
      }),
    );
    expect((await t.run(...createArgs, "--yes", "--json")).code).toBe(0);
    expect(t.calls.some((call) => call.method === "POST")).toBe(true);
    expect(t.parsed().data.reused).toBe(false);
  });
  it("--allow-duplicateなら同じ内容でも新しく作り、作成済みの冪等キーを使い回さない", async () => {
    await saveLogin();
    const t = cli(server());
    await t.run(...createArgs, "--yes", "--json");
    const second = cli(server(existing));
    expect(
      (await second.run(...createArgs, "--allow-duplicate", "--json")).code,
    ).toBe(2);
    expect(second.parsed().error.code).toBe("confirmation_required");
    expect(
      (await second.run(...createArgs, "--allow-duplicate", "--yes", "--json"))
        .code,
    ).toBe(0);
    expect(second.parsed().data.reused).toBe(false);
    const keys = [...t.calls, ...second.calls]
      .filter((call) => call.method === "POST")
      .map((call) => call.headers.get("Idempotency-Key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
  it("TTYでは確認を求め、承諾したときだけ作成する", async () => {
    await saveLogin();
    const declined = cli(server(), { tty: true, answer: "n" });
    expect((await declined.run(...createArgs)).code).toBe(2);
    expect(declined.calls.some((call) => call.method === "POST")).toBe(false);
    const accepted = cli(server(), { tty: true, answer: "y" });
    expect((await accepted.run(...createArgs)).code).toBe(0);
    expect(accepted.prompt).toHaveBeenCalledWith(
      expect.stringContaining("1,000円"),
    );
  });
  it("価格とaccess_urlの変更は確認が必要で、変更前後を示す", async () => {
    await saveLogin();
    const t = cli(server());
    const { code } = await t.run(
      "products",
      "update",
      "prd_1",
      "--price",
      "2000",
      "--json",
    );
    expect(code).toBe(2);
    expect(t.parsed().error).toMatchObject({
      code: "confirmation_required",
      details: { changes: { price_jpy: { from: 1000, to: 2000 } } },
    });
    expect(t.calls.some((call) => call.method === "PATCH")).toBe(false);
    await t.run(
      "products",
      "update",
      "prd_1",
      "--access-url",
      "https://site.example/new",
      "--json",
    );
    expect(t.parsed().error.message).toContain("購入者");
  });
  it("名前だけの変更は確認なしで実行する", async () => {
    await saveLogin();
    const t = cli(server());
    expect(
      (await t.run("products", "update", "prd_1", "--name", "新版", "--json"))
        .code,
    ).toBe(0);
    expect(t.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      name: "新版",
    });
  });
  it("変更項目が無ければ使い方の誤り", async () => {
    await saveLogin();
    const t = cli(server());
    expect((await t.run("products", "update", "prd_1", "--json")).code).toBe(2);
  });
  it("一覧はページをたどって全件を返す", async () => {
    await saveLogin();
    const t = cli(
      server({
        "GET /products?limit=100": () =>
          json({ items: [product], next_cursor: "c2" }),
        "GET /products?limit=100&cursor=c2": () =>
          json({ items: [{ ...product, id: "prd_2" }], next_cursor: null }),
      }),
    );
    expect((await t.run("products", "list", "--json")).code).toBe(0);
    expect(
      t.parsed().data.items.map((item: { id: string }) => item.id),
    ).toEqual(["prd_1", "prd_2"]);
  });
  it("存在しない商品はnot_foundで終了コード4", async () => {
    await saveLogin();
    const t = cli(
      server({
        "PUT /products/prd_x/checkout-link": () =>
          apiError("product_not_found", 404),
      }),
    );
    expect((await t.run("link", "prd_x", "--json")).code).toBe(4);
    expect(t.parsed().error.code).toBe("not_found");
  });
  it("getは商品と購入リンクを返す。リンクは取得だけで発行しない", async () => {
    await saveLogin();
    const t = cli(
      server({
        "GET /products/prd_1/checkout-link": () => json(link),
      }),
    );
    expect((await t.run("products", "get", "prd_1", "--json")).code).toBe(0);
    expect(t.parsed().data).toEqual({
      product,
      checkout_link: {
        id: "lnk_1",
        product_id: "prd_1",
        url: link.url,
        disabled: false,
      },
      next_step: null,
    });
    expect(t.calls.some((call) => call.method === "PUT")).toBe(false);
  });
  it("getは購入リンクが未発行でもエラーにせず、未発行と示す", async () => {
    await saveLogin();
    const t = cli(
      server({
        "GET /products/prd_1/checkout-link": () =>
          apiError("checkout_link_not_found", 404),
      }),
    );
    const human = await t.run("products", "get", "prd_1");
    expect(human.code).toBe(0);
    expect(human.out).toContain("購入リンク: 未発行");
    expect((await t.run("products", "get", "prd_1", "--json")).code).toBe(0);
    expect(t.parsed().data).toMatchObject({
      checkout_link: null,
      next_step: "npx @nulogic/cozeni-sdk link prd_1",
    });
  });
  it("getは存在しない商品をnot_foundで終了コード4にする", async () => {
    await saveLogin();
    const t = cli(
      server({
        "GET /products/prd_x": () => apiError("product_not_found", 404),
      }),
    );
    expect((await t.run("products", "get", "prd_x", "--json")).code).toBe(4);
    expect(t.parsed().error.code).toBe("not_found");
  });
  it("linkは標準の購入リンクを返す", async () => {
    await saveLogin();
    const t = cli(server());
    expect((await t.run("link", "prd_1", "--json")).code).toBe(0);
    expect(t.parsed().data).toEqual({
      checkout_link: {
        id: "lnk_1",
        product_id: "prd_1",
        url: link.url,
        disabled: false,
      },
    });
  });
});

describe("status", () => {
  it("販売可否と次にやること、商品一覧を返す", async () => {
    await saveLogin();
    const t = cli((call) =>
      call.path.endsWith("/account")
        ? json(account)
        : json({ items: [product], next_cursor: null }),
    );
    expect((await t.run("status", "--json")).code).toBe(0);
    const data = t.parsed().data;
    expect(data.sales.can_sell).toBe(false);
    expect(data.next_actions).toEqual([
      {
        code: "review_not_submitted",
        action_url: `${APP}/settings/review`,
        message: expect.any(String),
      },
    ]);
    expect(data.products).toHaveLength(1);
    expect(data.key).toEqual({
      id: "key_new",
      source: "saved",
      expires_at: token.expires_at,
    });
    expect(data.warnings).toEqual([]);
  });
  it("利用者にそのまま見せる次にやることを返す", async () => {
    await saveLogin();
    const t = cli((call) =>
      call.path.endsWith("/account")
        ? json({
            ...account,
            sales: {
              can_sell: false,
              blockers: [
                {
                  code: "review_rejected",
                  action_url: `${APP}/settings/review`,
                  rejection: {
                    reason_code: "other",
                    note: "特商法の表記が不足",
                  },
                },
                {
                  code: "stripe_not_connected",
                  action_url: `${APP}/settings/payouts`,
                },
              ],
              warnings: [],
            },
          })
        : json({ items: [], next_cursor: null }),
    );
    await t.run("status", "--json");
    const data = t.parsed().data;
    expect(data.message_for_user).toEqual([
      "販売を始めるには、次の手続きが必要です。",
      `1. 審査で差し戻されました。指摘を直して再申請してください（理由: 特商法の表記が不足）。 ${APP}/settings/review`,
      `2. Stripeアカウントを接続してください。 ${APP}/settings/payouts`,
    ]);
    expect(data.next_step).toBe(
      'npx @nulogic/cozeni-sdk products create --name "<商品名>" --price <円> --access-url "<URL>"',
    );
  });
  it("販売できるなら「すぐ販売できます」と返す", async () => {
    await saveLogin();
    const t = cli((call) =>
      call.path.endsWith("/account")
        ? json({
            ...account,
            sales: { can_sell: true, blockers: [], warnings: [] },
          })
        : json({ items: [product], next_cursor: null }),
    );
    const human = await t.run("status");
    expect(human.out).toContain("すぐ販売できます");
    await t.run("status", "--json");
    expect(t.parsed().data).toMatchObject({
      message_for_user: ["すぐ販売できます。"],
      next_step: null,
    });
  });
  it("販売状態が取れなければ、推測せず管理画面を案内する", async () => {
    await saveLogin();
    const { sales: _, ...legacy } = account;
    const t = cli((call) =>
      call.path.endsWith("/account")
        ? json(legacy)
        : json({ items: [], next_cursor: null }),
    );
    await t.run("status", "--json");
    expect(t.parsed().data.message_for_user).toEqual([
      `販売できる状態かを確かめられませんでした。Cozeni の管理画面で確認してください。 ${APP}`,
    ]);
  });
  it("キーの期限まで7日を切ったらkey_expiringを返す", async () => {
    await saveLogin({ expires_at: "2026-09-30T00:00:00.000Z" });
    const t = cli((call) =>
      call.path.endsWith("/account")
        ? json(account)
        : json({ items: [], next_cursor: null }),
    );
    await t.run("status", "--json");
    expect(t.parsed().data.warnings).toEqual(["key_expiring"]);
  });
});

describe("使い方と版の照合", () => {
  it("不明なコマンド・オプションは終了コード2", async () => {
    const t = cli(() => json({}));
    expect((await t.run("unknown", "--json")).code).toBe(2);
    expect((await t.run("whoami", "--bogus", "--json")).code).toBe(2);
    expect((await t.run("whoami", "--complete", "--json")).code).toBe(2);
  });
  it("--helpと--versionは通信しない", async () => {
    const t = cli(() => json({}));
    expect((await t.run("--help")).out).toContain("login");
    expect((await t.run("--version")).out.trim()).toBe(version);
    expect(t.calls).toHaveLength(0);
  });
  it("同梱のskillはこの版のSDKに対応している", async () => {
    const skill = await readFile(
      new URL("../skills/cozeni-setup/SKILL.md", import.meta.url),
      "utf8",
    );
    const range = skillRange(skill);
    expect(range).toBeDefined();
    expect(satisfies(version, range ?? "")).toBe(true);
  });
  it("skillの対応版とずれていれば警告だけ出して続ける", async () => {
    await mkdir(join(home, ".claude", "skills", "cozeni-setup"), {
      recursive: true,
    });
    await writeFile(
      join(home, ".claude", "skills", "cozeni-setup", "SKILL.md"),
      '---\nname: cozeni-setup\ndescription: x\nmetadata:\n  cozeni-sdk-version: ">=0.1.0 <0.2.0"\n---\n',
    );
    await saveLogin();
    const t = cli(() => json(account));
    const { code, err } = await t.run("whoami", "--json");
    expect(code).toBe(0);
    expect(err).toContain("npx @nulogic/cozeni-sdk init");
  });
});

async function saveConfig(
  config: Parameters<ReturnType<typeof createStore>["saveConfig"]>[0],
) {
  await createStore({ XDG_CONFIG_HOME: home }).saveConfig(config);
}
const expected = (creator = "crt_1") => ({
  version: 1 as const,
  default_profile: "production",
  profiles: {
    production: { expected_creator_id: creator.replace(/^crt_/, "cre_") },
  },
});

describe("既定のプロファイル", () => {
  it("--profileを省略したらconfig.jsonのdefault_profileと、その接続先を使う", async () => {
    await saveConfig({
      version: 1,
      default_profile: "staging",
      profiles: {
        staging: {
          api_origin: "https://api.staging.example",
          app_origin: "https://app.staging.example",
        },
      },
    });
    const t = cli(() => json(deviceCode));
    await t.run("login", "--json");
    expect(t.calls[0]?.path).toBe(
      "https://api.staging.example/external/v1/cli/device-codes",
    );
    expect(t.calls).toHaveLength(1);
  });
  it("既定のプロファイルでは次のコマンドに--profileを付けない", async () => {
    await saveConfig({
      version: 1,
      default_profile: "staging",
      profiles: {
        staging: {
          api_origin: "https://api.staging.example",
          app_origin: "https://app.staging.example",
        },
      },
    });
    const t = cli(() =>
      json({
        ...deviceCode,
        verification_uri: "https://app.staging.example/device",
        verification_uri_complete: undefined,
      }),
    );
    expect((await t.run("login", "--json")).code).toBe(0);
    expect(t.parsed().data.next_step).toBe(
      "npx @nulogic/cozeni-sdk login --complete",
    );
  });
  it("config.jsonが無ければproduction", async () => {
    await saveLogin();
    const t = cli(() => json(account));
    await t.run("whoami", "--json");
    expect(t.calls[0]?.path).toBe(`${API}/external/v1/account`);
  });
});

describe("loginの冪等化とクリエイターの照合", () => {
  const cre = { ...account, creator_id: "cre_1" };
  const creToken = { ...token, creator_id: "cre_1" };
  it("保存済みのキーが有効で期待するクリエイターなら、何もせず成功する", async () => {
    await saveConfig(expected("cre_1"));
    await saveLogin({ creator_id: "cre_1" });
    const t = cli(() => json(cre));
    expect((await t.run("login", "--json")).code).toBe(0);
    expect(t.calls.map((call) => call.path)).toEqual([
      `${API}/external/v1/account`,
    ]);
    expect(t.parsed().data).toMatchObject({
      already_logged_in: true,
      creator_id: "cre_1",
      next_step: "npx @nulogic/cozeni-sdk status",
    });
  });
  it.each([
    [
      "別のクリエイターのキー",
      { creator_id: "cre_other" },
      () => json({ ...cre, creator_id: "cre_other" }),
    ],
    [
      "期限まで7日を切ったキー",
      { creator_id: "cre_1", expires_at: "2026-09-30T00:00:00.000Z" },
      () => json(cre),
    ],
    [
      "失効したキー",
      { creator_id: "cre_1" },
      () => apiError("unauthorized", 401),
    ],
  ] as const)(
    "%sなら新しくログインを始める",
    async (_, saved, accountResponse) => {
      await saveConfig(expected("cre_1"));
      await saveLogin(saved);
      const t = cli(({ path }) =>
        path.endsWith("/account") ? accountResponse() : json(deviceCode),
      );
      expect((await t.run("login", "--json")).code).toBe(0);
      expect(t.parsed().data.user_code).toBe("BCDF-GHJK");
      expect(
        t.calls.some((call) => call.path.endsWith("/cli/device-codes")),
      ).toBe(true);
    },
  );
  it("--completeで得たキーが期待と違えば保存せず失効させ、creator_mismatchで止める", async () => {
    await saveConfig(expected("cre_1"));
    const t = cli(({ path }) => {
      if (path.endsWith("/cli/device-codes")) return json(deviceCode);
      if (path.endsWith("/cli/tokens"))
        return json({ ...creToken, creator_id: "cre_other" });
      return new Response(null, { status: 204 });
    });
    await t.run("login", "--json");
    const { code, out } = await t.run("login", "--complete", "--json");
    expect(code).toBe(4);
    const error = t.parsed().error;
    expect(error.code).toBe("creator_mismatch");
    expect(error.message).toContain("別のアカウント");
    expect(error).toMatchObject({
      expected_creator_id: "cre_1",
      actual_creator_id: "cre_other",
    });
    expect(out).not.toContain(creToken.api_key);
    const logout = t.calls.find((call) => call.path.endsWith("/cli/logout"));
    expect(logout?.headers.get("Authorization")).toBe(
      `Bearer ${creToken.api_key}`,
    );
    expect(
      await createStore({ XDG_CONFIG_HOME: home }).loadCredential("production"),
    ).toBeUndefined();
    await expect(
      lstat(join(home, "cozeni", "pending", "login-production.json")),
    ).rejects.toThrow();
  });
  it("--completeで期待どおりなら保存し、次にstatusを案内する", async () => {
    await saveConfig(expected("cre_1"));
    const t = cli(({ path }) =>
      path.endsWith("/cli/device-codes") ? json(deviceCode) : json(creToken),
    );
    await t.run("login", "--json");
    expect((await t.run("login", "--complete", "--json")).code).toBe(0);
    expect(t.parsed().data).toMatchObject({
      already_logged_in: false,
      creator_id: "cre_1",
      next_step: "npx @nulogic/cozeni-sdk status",
    });
  });
  it("保存済みのキーのクリエイターが違えば、要求を送らずに止める", async () => {
    await saveConfig(expected("cre_1"));
    await saveLogin({ creator_id: "cre_other" });
    const t = cli(() => json(cre));
    const { code } = await t.run("link", "prd_1", "--json");
    expect(code).toBe(4);
    expect(t.parsed().error.code).toBe("creator_mismatch");
    expect(t.calls).toHaveLength(0);
  });
  it("COZENI_API_KEYのクリエイターが違えば、GET /accountだけで止める", async () => {
    await saveConfig(expected("cre_1"));
    const t = cli(() => json({ ...cre, creator_id: "cre_other" }), {
      env: { COZENI_API_KEY: "cozeni_env_secret" },
    });
    const { code } = await t.run(
      "products",
      "create",
      "--name",
      "x",
      "--price",
      "1000",
      "--access-url",
      "https://site.example/m",
      "--yes",
      "--json",
    );
    expect(code).toBe(4);
    expect(t.parsed().error.code).toBe("creator_mismatch");
    expect(t.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${API}/external/v1/account`,
    ]);
  });
  it("期待するクリエイターと一致すれば通常どおり動く", async () => {
    await saveConfig(expected("cre_1"));
    await saveLogin({ creator_id: "cre_1" });
    const t = cli(() => json(cre));
    expect((await t.run("whoami", "--json")).code).toBe(0);
    expect(t.parsed().data.expected_creator_id).toBe("cre_1");
  });
});
