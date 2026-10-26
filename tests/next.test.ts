import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      state.cookies.has(name)
        ? { name, value: state.cookies.get(name) }
        : undefined,
  }),
}));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  }),
);
vi.mock("next/navigation", () => ({ redirect }));

import {
  AccessDenied,
  clearCozeniHandoff,
  cozeniProxy,
  createCheckout,
  entitlement,
  getCustomerState,
  handleCozeniHandoff,
  hasFeatureFlag,
  portalRedirect,
  requireEntitlement,
} from "../src/next.js";

const SITE = "https://creator.example";
const ENTER = "https://checkout.cozeni.net/enter?product_id=prd_1";
let fetch: ReturnType<typeof vi.fn>;
function api(respond: (path: string, body: unknown) => Response) {
  fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    return respond(
      `${url.origin}${url.pathname}`,
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    );
  });
  vi.stubGlobal("fetch", fetch);
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const setCookies = (response: Response) => response.headers.getSetCookie();

beforeEach(() => {
  state.cookies.clear();
  redirect.mockClear();
  vi.stubEnv("COZENI_SITE_ORIGIN", SITE);
  vi.stubEnv("COZENI_API_ORIGIN", "");
  vi.stubEnv("COZENI_ENVIRONMENT", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("cozeniProxy のハンドオフ", () => {
  it("コードを交換してCookieと印を設定し、コードを除いた自サイトのURLへ303で戻す", async () => {
    api(() => json({ token: "buyer.jwt.token" }));
    const response = await cozeniProxy(
      new Request("https://evil.example/members?x=1&cozeni_code=once&y=2"),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.cozeni.net/external/v1/customer/handoff/exchange",
    );
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe(`${SITE}/members?x=1&y=2`);
    expect(response?.headers.get("cache-control")).toContain("no-store");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    const cookies = setCookies(response as Response);
    expect(cookies).toContain(
      "cozeni_customer=buyer.jwt.token; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure",
    );
    expect(cookies).toContain(
      "cozeni_handoff=ok; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure",
    );
  });
  it("パスが//で始まっても自サイトのオリジンから出ない", async () => {
    api(() => json({ token: "buyer.jwt.token" }));
    const response = await cozeniProxy(
      new Request("https://creator.example//evil.example/x?cozeni_code=once"),
    );
    expect(new URL(response?.headers.get("location") ?? "").origin).toBe(SITE);
  });
  it("COZENI_API_ORIGINで接続先を上書きできる", async () => {
    vi.stubEnv("COZENI_API_ORIGIN", "http://localhost:8787");
    api(() => json({ token: "buyer.jwt.token" }));
    await cozeniProxy(new Request(`${SITE}/members?cozeni_code=once`));
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:8787/external/v1/customer/handoff/exchange",
    );
  });
  it("交換に失敗したら購入者Cookieを変えず、invalid_codeの印で戻す", async () => {
    api(() =>
      json(
        { error: { code: "invalid_code", message: "x", request_id: "r" } },
        400,
      ),
    );
    const response = await cozeniProxy(
      new Request(`${SITE}/members?cozeni_code=used`),
    );
    expect(response?.headers.get("location")).toBe(`${SITE}/members`);
    const cookies = setCookies(response as Response);
    expect(
      cookies.some((cookie) => cookie.startsWith("cozeni_customer=")),
    ).toBe(false);
    expect(cookies[0]).toMatch(/^cozeni_handoff=invalid_code;/);
  });
  it("交換の障害はunavailableの印にする", async () => {
    api(() => {
      throw new TypeError("fetch failed");
    });
    const response = await cozeniProxy(
      new Request(`${SITE}/members?cozeni_code=once`),
    );
    expect(setCookies(response as Response)[0]).toMatch(
      /^cozeni_handoff=unavailable;/,
    );
  });
  it.each(["?cozeni_code=", "?cozeni_code=a&cozeni_code=b"])(
    "空・複数のコード（%s）は交換せずinvalid_codeにする",
    async (search) => {
      api(() => json({ token: "t" }));
      const response = await cozeniProxy(
        new Request(`${SITE}/members${search}`),
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(response?.headers.get("location")).toBe(`${SITE}/members`);
      expect(setCookies(response as Response)[0]).toMatch(
        /^cozeni_handoff=invalid_code;/,
      );
    },
  );
  it("HTTPのローカル開発ではSecureを付けない", async () => {
    vi.stubEnv("COZENI_SITE_ORIGIN", "http://127.0.0.1:3100");
    api(() => json({ token: "t.t.t" }));
    const response = await cozeniProxy(
      new Request("http://127.0.0.1:3100/members?cozeni_code=once"),
    );
    for (const cookie of setCookies(response as Response))
      expect(cookie).not.toContain("Secure");
  });
  it("COZENI_SITE_ORIGINが無ければ交換せず503にする", async () => {
    vi.stubEnv("COZENI_SITE_ORIGIN", "");
    api(() => json({ token: "t" }));
    const response = await cozeniProxy(
      new Request(`${SITE}/members?cozeni_code=once`),
    );
    expect(response?.status).toBe(503);
    expect(response?.headers.has("location")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("GET以外のリクエストではコードを交換しない", async () => {
    api(() => json({ token: "t" }));
    expect(
      await cozeniProxy(
        new Request(`${SITE}/members?cozeni_code=once`, { method: "POST" }),
      ),
    ).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("コードも印も無いリクエストには何もしない", async () => {
    api(() => json({}));
    expect(await cozeniProxy(new Request(`${SITE}/members`))).toBeUndefined();
    expect(
      await handleCozeniHandoff(new Request(`${SITE}/members`)),
    ).toBeUndefined();
  });
  it("次のリクエストでは印を残したまま通し、応答で消す", async () => {
    api(() => json({}));
    const response = await cozeniProxy(
      new Request(`${SITE}/members`, {
        headers: { Cookie: "cozeni_handoff=ok; other=1" },
      }),
    );
    // NextResponse.next()（ページへ通す）であること。
    expect(response?.headers.get("x-middleware-next")).toBe("1");
    expect(setCookies(response as Response)).toEqual([
      "cozeni_handoff=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    ]);
    // response.cookies経由だと、同じリクエストのページからも印が消えてしまう。
    expect(response?.headers.has("x-middleware-set-cookie")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("既存のmiddlewareとの組み合わせ", () => {
  it("handleCozeniHandoffは印だけのリクエストを横取りしない（既存の処理を飛ばさせない）", async () => {
    api(() => json({}));
    expect(
      await handleCozeniHandoff(
        new Request(`${SITE}/admin`, {
          headers: { Cookie: "cozeni_handoff=ok" },
        }),
      ),
    ).toBeUndefined();
  });
  it("clearCozeniHandoffは印があるときだけ既存の応答で印を消す", () => {
    const marked = new Request(`${SITE}/members`, {
      headers: { Cookie: "cozeni_handoff=ok" },
    });
    // Response.redirect()のようにヘッダーを変更できない応答でも扱える。
    const redirected = clearCozeniHandoff(
      marked,
      Response.redirect(`${SITE}/login`, 307),
    );
    expect(redirected.status).toBe(307);
    expect(redirected.headers.get("location")).toBe(`${SITE}/login`);
    expect(setCookies(redirected)).toEqual([
      "cozeni_handoff=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    ]);
    const untouched = new Response("ok");
    expect(clearCozeniHandoff(new Request(`${SITE}/members`), untouched)).toBe(
      untouched,
    );
    expect(setCookies(untouched)).toEqual([]);
  });
});

describe("requireEntitlement(productId)", () => {
  it("権利があれば何もしない。既定の接続先は本番", async () => {
    state.cookies.set("cozeni_customer", "a.b.c");
    api(() => json({ entitled: true }));
    await expect(requireEntitlement("prd_1")).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.cozeni.net/external/v1/customer/entitlements/check",
    );
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ product_id: "prd_1" }),
    );
  });
  it("印が無い拒否はenter_urlへリダイレクトする", async () => {
    api(() =>
      json({ entitled: false, reason: "no_session", enter_url: ENTER }, 401),
    );
    await expect(requireEntitlement("prd_1")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith(ENTER);
  });
  it.each(["ok", "invalid_code", "unknown"])(
    "印（%s）がある拒否はリダイレクトせずAccessDeniedを投げる",
    async (mark) => {
      state.cookies.set("cozeni_handoff", mark);
      api(() =>
        json({ entitled: false, reason: "no_grant", enter_url: ENTER }),
      );
      const error = await requireEntitlement("prd_1").catch((e) => e);
      expect(error).toBeInstanceOf(AccessDenied);
      expect(error.reason).toBe("no_grant");
      expect(redirect).not.toHaveBeenCalled();
    },
  );
  it("印がunavailableなら理由をunavailableとして扱う", async () => {
    state.cookies.set("cozeni_handoff", "unavailable");
    api(() =>
      json({ entitled: false, reason: "no_session", enter_url: ENTER }, 401),
    );
    const error = await requireEntitlement("prd_1").catch((e) => e);
    expect(error).toBeInstanceOf(AccessDenied);
    expect(error.reason).toBe("unavailable");
  });
  it("判定不能（503）ではリダイレクトもコンテンツも返さない", async () => {
    api(() => json({ entitled: false, reason: "unavailable" }, 503));
    const error = await requireEntitlement("prd_1").catch((e) => e);
    expect(error).toBeInstanceOf(AccessDenied);
    expect(error.reason).toBe("unavailable");
    expect(redirect).not.toHaveBeenCalled();
  });
  it("旧シグネチャ（options）はこれまでどおり動く", async () => {
    api(() => json({ entitled: false, reason: "no_grant", enter_url: ENTER }));
    await expect(
      requireEntitlement({
        apiOrigin: "http://localhost:8787",
        productId: "prd_1",
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:8787/external/v1/customer/entitlements/check",
    );
    const halted = await requireEntitlement({
      apiOrigin: "http://localhost:8787",
      productId: "prd_1",
      haltRedirect: true,
    }).catch((e) => e);
    expect(halted).toBeInstanceOf(AccessDenied);
  });
});

describe("portalRedirect(creatorId)", () => {
  const CREATOR = "cre_0123456789abcdef0123456789abcdef";
  const CODE = "b2".repeat(32);
  const PORTAL = `https://checkout.cozeni.net/portal/${CREATOR}`;
  const error = (code: string, status: number) =>
    json({ error: { code, message: "x", request_id: "req_1" } }, status);
  const privateHeaders = (response: Response) => {
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  };
  it("発行したURLへ302で送る。購入者Cookieだけを本番のAPIへ転送する", async () => {
    state.cookies.set("cozeni_customer", "a.b.c");
    state.cookies.set("session", "site-secret");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    api(() => json({ url: `${PORTAL}?cozeni_portal_code=${CODE}` }));
    const response = await portalRedirect(CREATOR);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${PORTAL}?cozeni_portal_code=${CODE}`,
    );
    privateHeaders(response);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.cozeni.net/external/v1/customer/portal-link",
    );
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("cookie")).toBe(
      "cozeni_customer=a.b.c",
    );
    // URLとコードはログに出さない。
    const logged = JSON.stringify([
      log.mock.calls,
      info.mock.calls,
      err.mock.calls,
    ]);
    expect(logged).not.toContain(CODE);
  });
  it("サンドボックスでは購入者面のオリジンもサンドボックスのものだけを受け付ける", async () => {
    vi.stubEnv("COZENI_ENVIRONMENT", "sandbox");
    state.cookies.set("cozeni_customer", "a.b.c");
    const sandboxPortal = `https://checkout-sandbox.cozeni.net/portal/${CREATOR}`;
    api(() => json({ url: `${sandboxPortal}?cozeni_portal_code=${CODE}` }));
    const response = await portalRedirect(CREATOR);
    expect(response.status).toBe(302);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api-sandbox.cozeni.net/external/v1/customer/portal-link",
    );
    api(() => json({ url: `${PORTAL}?cozeni_portal_code=${CODE}` }));
    expect((await portalRedirect(CREATOR)).status).toBe(503);
  });
  it("Cookieが無ければAPIを呼ばず、Cozeniのその販売者のポータルへ送る（ポータルが確認コードの入場へ送る）", async () => {
    api(() => json({}));
    const response = await portalRedirect(CREATOR);
    expect(fetch).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(PORTAL);
    privateHeaders(response);
  });
  it("401（no_session）でもCozeniのポータルへ送る。サンドボックスならサンドボックスの購入者面", async () => {
    state.cookies.set("cozeni_customer", "expired.jwt.value");
    api(() => error("no_session", 401));
    expect((await portalRedirect(CREATOR)).headers.get("location")).toBe(
      PORTAL,
    );
    vi.stubEnv("COZENI_ENVIRONMENT", "sandbox");
    expect((await portalRedirect(CREATOR)).headers.get("location")).toBe(
      `https://checkout-sandbox.cozeni.net/portal/${CREATOR}`,
    );
  });
  it("COZENI_API_ORIGINで独自の接続先を使うときは購入者面が分からないので、401で返しリダイレクトしない", async () => {
    vi.stubEnv("COZENI_API_ORIGIN", "http://localhost:8787");
    vi.spyOn(console, "info").mockImplementation(() => {});
    api(() => error("no_session", 401));
    state.cookies.set("cozeni_customer", "a.b.c");
    const response = await portalRedirect(CREATOR);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:8787/external/v1/customer/portal-link",
    );
    expect(response.status).toBe(401);
    expect(response.headers.has("location")).toBe(false);
    privateHeaders(response);
  });
  it.each([
    ["503", () => error("unavailable", 503)],
    ["本文がno_sessionの503（契約外）", () => error("no_session", 503)],
    [
      "通信失敗",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["検証に通らないURL", () => json({ url: "https://evil.example/" })],
    [
      "別の販売者のポータル",
      () =>
        json({
          url: `https://checkout.cozeni.net/portal/cre_other?cozeni_portal_code=${CODE}`,
        }),
    ],
  ])("%sでは503を返し、再入場へ変換しない", async (_label, respond) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.cookies.set("cozeni_customer", "a.b.c");
    api(respond);
    const response = await portalRedirect(CREATOR);
    expect(response.status).toBe(503);
    expect(response.headers.has("location")).toBe(false);
    privateHeaders(response);
  });
  it("URLの販売者が違うときは、値を含まない固定文で設定の確認を促す", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    state.cookies.set("cozeni_customer", "a.b.c");
    api(() =>
      json({
        url: `https://checkout.cozeni.net/portal/cre_other?cozeni_portal_code=${CODE}`,
      }),
    );
    expect((await portalRedirect(CREATOR)).status).toBe(503);
    // 引数は固定文の1つだけ（URL・コード・IDの値を足していない）。
    expect(err.mock.calls).toEqual([
      [
        "[cozeni] 購入者ポータルへのリンクの応答を確認できませんでした。portalRedirect() に渡したクリエイターIDと、接続先の環境（COZENI_ENVIRONMENT）が合っているかを確認してください。",
      ],
    ]);
  });
  it.each(["", "prd_1", "cre_x/../../evil", "cre_x?next=1"])(
    "creatorIdが不正（%s）なら問い合わせず503にする",
    async (creatorId) => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      state.cookies.set("cozeni_customer", "a.b.c");
      api(() => json({ url: `${PORTAL}?cozeni_portal_code=${CODE}` }));
      const response = await portalRedirect(creatorId);
      expect(response.status).toBe(503);
      expect(response.headers.has("location")).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
    },
  );
  it("接続先の設定が不正なら問い合わせず503にする", async () => {
    vi.stubEnv("COZENI_ENVIRONMENT", "staging");
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.cookies.set("cozeni_customer", "a.b.c");
    api(() => json({ url: `${PORTAL}?cozeni_portal_code=${CODE}` }));
    expect((await portalRedirect(CREATOR)).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("entitlement(productId)", () => {
  it("リダイレクトせずに結果を返す", async () => {
    api(() => json({ entitled: false, reason: "no_grant", enter_url: ENTER }));
    expect(await entitlement("prd_1")).toEqual({
      entitled: false,
      reason: "no_grant",
      enterUrl: ENTER,
    });
    expect(redirect).not.toHaveBeenCalled();
  });
  it("接続先の設定が不正ならunavailable", async () => {
    vi.stubEnv("COZENI_API_ORIGIN", "not a url");
    api(() => json({ entitled: true }));
    expect(await entitlement("prd_1")).toEqual({
      entitled: false,
      reason: "unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("COZENI_ENVIRONMENT", () => {
  const SANDBOX = "https://api-sandbox.cozeni.net";
  it("sandboxならサンドボックスのAPIへ問い合わせる", async () => {
    vi.stubEnv("COZENI_ENVIRONMENT", "sandbox");
    api(() => json({ token: "buyer.jwt.token" }));
    await cozeniProxy(new Request(`${SITE}/members?cozeni_code=once`));
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `${SANDBOX}/external/v1/customer/handoff/exchange`,
    );
    api(() => json({ entitled: true }));
    expect(await entitlement("prd_1")).toEqual({ entitled: true });
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(
      new RegExp(`^${SANDBOX}/external/v1/`),
    );
  });
  it("productionなら本番", async () => {
    vi.stubEnv("COZENI_ENVIRONMENT", "production");
    api(() => json({ entitled: true }));
    await entitlement("prd_1");
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/api\.cozeni\.net\//,
    );
  });
  it("不明な値なら問い合わせず、unavailableと503にして理由をログに出す", async () => {
    vi.stubEnv("COZENI_ENVIRONMENT", "staging");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    api(() => json({ token: "buyer.jwt.token" }));
    expect(await entitlement("prd_1")).toEqual({
      entitled: false,
      reason: "unavailable",
    });
    const response = await cozeniProxy(
      new Request(`${SITE}/members?cozeni_code=once`),
    );
    expect(response?.status).toBe(503);
    expect(setCookies(response as Response)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("COZENI_ENVIRONMENT"),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("staging");
  });
  it("COZENI_API_ORIGINが別の環境を指していれば問い合わせない", async () => {
    vi.stubEnv("COZENI_ENVIRONMENT", "sandbox");
    vi.stubEnv("COZENI_API_ORIGIN", "https://api.cozeni.net");
    vi.spyOn(console, "error").mockImplementation(() => {});
    api(() => json({ entitled: true }));
    expect(await entitlement("prd_1")).toEqual({
      entitled: false,
      reason: "unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("COZENI_API_ORIGINがその環境のオリジンなら使う", async () => {
    vi.stubEnv("COZENI_ENVIRONMENT", "sandbox");
    vi.stubEnv("COZENI_API_ORIGIN", SANDBOX);
    api(() => json({ entitled: true }));
    expect(await entitlement("prd_1")).toEqual({ entitled: true });
  });
  it("開発中は最初の問い合わせで接続先の環境名を1回だけログに出す", async () => {
    vi.resetModules();
    const next = await import("../src/next.js");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("COZENI_ENVIRONMENT", "sandbox");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    api(() => json({ entitled: true }));
    await next.entitlement("prd_1");
    await next.entitlement("prd_1");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      `[cozeni] 接続先: サンドボックス（${SANDBOX}）`,
    );
  });
  it("本番ビルドでは接続先をログに出さない", async () => {
    vi.resetModules();
    const next = await import("../src/next.js");
    vi.stubEnv("NODE_ENV", "production");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    api(() => json({ entitled: true }));
    await next.entitlement("prd_1");
    expect(info).not.toHaveBeenCalled();
  });
});

describe("機能フラグの3関数（COZENI_API_KEYを環境変数から読む）", () => {
  const KEY = `cozeni_sk_${"b".repeat(64)}`;
  const PUBLIC_KEY = `cozeni_sk_${"a".repeat(64)}`;
  const EMAIL = "hanako@example.com";
  const MISSING =
    "[cozeni] COZENI_API_KEY が設定されていません。管理画面の開発者設定で発行したキーを、サーバーの環境変数に設定してください。";
  const BROWSER_KEY =
    "[cozeni] NEXT_PUBLIC_COZENI_API_KEY はブラウザに渡ります。キーを消して失効させ、COZENI_API_KEY（NEXT_PUBLIC_ を付けない）に設定し直してください。";
  const state = {
    customer_id: "cus_1",
    feature_flags: [
      {
        product_id: "prd_1",
        benefit_id: "ben_1",
        granted_at: "2026-10-23T03:00:00.000Z",
        metadata: { plan: "pro" },
      },
    ],
  };
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubEnv("COZENI_API_KEY", KEY);
    vi.stubEnv("NEXT_PUBLIC_COZENI_API_KEY", undefined);
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("COZENI_API_KEYとCOZENI_ENVIRONMENT=sandboxでサンドボックスのAPIへ、キーを付けて送る", async () => {
    vi.stubEnv("COZENI_ENVIRONMENT", "sandbox");
    api(() => json(state));
    expect(await getCustomerState({ email: EMAIL })).toEqual({
      customerId: "cus_1",
      featureFlags: [
        {
          productId: "prd_1",
          benefitId: "ben_1",
          grantedAt: "2026-10-23T03:00:00.000Z",
          metadata: { plan: "pro" },
        },
      ],
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api-sandbox.cozeni.net/external/v1/customers/state",
    );
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe(
      `Bearer ${KEY}`,
    );
  });
  it("COZENI_ENVIRONMENTが無ければ本番のAPIへ送る", async () => {
    api(() => json(state));
    await getCustomerState({ email: EMAIL });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.cozeni.net/external/v1/customers/state",
    );
  });
  it("hasFeatureFlagは持っている商品ならgrantedとmetadataを返し、無ければ空で返す", async () => {
    api(() => json(state));
    expect(await hasFeatureFlag({ email: EMAIL, productId: "prd_1" })).toEqual({
      granted: true,
      metadata: { plan: "pro" },
    });
    expect(await hasFeatureFlag({ email: EMAIL, productId: "prd_2" })).toEqual({
      granted: false,
      metadata: {},
    });
  });
  it("createCheckoutは購入画面を作り、camelCaseで返す", async () => {
    vi.stubEnv("COZENI_ENVIRONMENT", "sandbox");
    const url = "https://checkout-sandbox.cozeni.net/checkout/a?checkout=chk_1";
    api(() =>
      json(
        { checkout_id: "chk_1", url, expires_at: "2026-10-26T03:30:00.000Z" },
        201,
      ),
    );
    expect(await createCheckout({ productId: "prd_1", email: EMAIL })).toEqual({
      checkoutId: "chk_1",
      url,
      expiresAt: "2026-10-26T03:30:00.000Z",
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api-sandbox.cozeni.net/external/v1/checkout/sessions",
    );
  });
  it("COZENI_API_KEYが無ければinvalid_inputを投げ、通信せず、固定文を1回だけログに出す", async () => {
    vi.stubEnv("COZENI_API_KEY", undefined);
    api(() => json(state));
    await expect(
      hasFeatureFlag({ email: EMAIL, productId: "prd_1" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
    expect(errorLog.mock.calls).toEqual([[MISSING]]);
  });
  it.each([
    ["", "空"],
    ["   ", "空白だけ"],
  ])("COZENI_API_KEYが%j（%s）でも設定なしとして扱う", async (value) => {
    vi.stubEnv("COZENI_API_KEY", value);
    api(() => json(state));
    await expect(getCustomerState({ email: EMAIL })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      createCheckout({ productId: "prd_1", email: EMAIL }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
    expect(errorLog.mock.calls).toEqual([[MISSING], [MISSING]]);
  });
  it("NEXT_PUBLIC_COZENI_API_KEYがあれば使わずにinvalid_inputを投げ、ログに値を出さない", async () => {
    vi.stubEnv("NEXT_PUBLIC_COZENI_API_KEY", PUBLIC_KEY);
    vi.stubEnv("COZENI_API_KEY", KEY);
    api(() => json(state));
    await expect(
      hasFeatureFlag({ email: "a@example.com", productId: "prd_1" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
    expect(errorLog.mock.calls).toEqual([[BROWSER_KEY]]);
    expect(errorLog.mock.calls.flat().join("")).not.toContain("cozeni_sk_");
  });
  it("NEXT_PUBLIC_COZENI_API_KEYは値が空でも、COZENI_API_KEYが無くても、ブラウザへ渡る設定として拒否する", async () => {
    vi.stubEnv("NEXT_PUBLIC_COZENI_API_KEY", "");
    api(() => json(state));
    await expect(getCustomerState({ email: EMAIL })).rejects.toMatchObject({
      code: "invalid_input",
    });
    vi.stubEnv("COZENI_API_KEY", undefined);
    await expect(
      createCheckout({ productId: "prd_1", email: EMAIL }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
    expect(errorLog.mock.calls).toEqual([[BROWSER_KEY], [BROWSER_KEY]]);
  });
  it("接続先の設定が不正なら通信せずinvalid_inputを投げ、キーをログに出さない", async () => {
    vi.stubEnv("COZENI_ENVIRONMENT", "staging");
    api(() => json(state));
    await expect(getCustomerState({ email: EMAIL })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(errorLog.mock.calls.flat().join("")).not.toContain("cozeni_sk_");
  });
  it("APIの失敗はCozeniErrorのcodeとstatusのまま投げる（サンドボックスの宛先違い）", async () => {
    vi.stubEnv("COZENI_ENVIRONMENT", "sandbox");
    api(() =>
      json(
        {
          error: {
            code: "sandbox_recipient_not_allowed",
            message: "失敗",
            request_id: "req_1",
          },
        },
        422,
      ),
    );
    await expect(
      createCheckout({ productId: "prd_1", email: "other@example.com" }),
    ).rejects.toMatchObject({
      code: "sandbox_recipient_not_allowed",
      status: 422,
    });
    expect(errorLog).not.toHaveBeenCalled();
  });
});
