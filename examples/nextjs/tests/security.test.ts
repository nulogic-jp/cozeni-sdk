import { renderToStaticMarkup } from "react-dom/server";
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
// next/navigationのredirect()は本来Next.jsの制御フロー例外を投げる。テストでは
// 呼び出し先URLを記録しつつ、同じく例外を投げて呼び出し元のcatchの挙動を検証する。
const redirectMock = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  }),
);
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

import { GET as dataRoute } from "../app/api/protected/route";
import { protectedAction } from "../app/members/actions";
import Members from "../app/members/page";
import { GET as portalRoute } from "../app/portal/route";
import { PROTECTED_CONTENT } from "../lib/content";
import { CREATOR_ID, PRODUCT_ID } from "../lib/cozeni";
import nextConfig from "../next.config";
import { config, proxy } from "../proxy";

const enterUrl = `https://checkout.cozeni.net/enter?product_id=${PRODUCT_ID}`;
beforeEach(() => {
  state.cookies.clear();
  state.cookies.set("cozeni_customer", "valid.token.jwt");
  redirectMock.mockClear();
  vi.stubEnv("COZENI_SITE_ORIGIN", "https://creator.example");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function api(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}
const page = async () => renderToStaticMarkup(await Members());

describe("各入口で独立に認可する", () => {
  it("許可された購入者だけにページ・Route・Actionで本文を返す", async () => {
    api({ entitled: true });
    expect(await page()).toContain(PROTECTED_CONTENT);
    expect(await (await dataRoute()).json()).toEqual({
      content: PROTECTED_CONTENT,
    });
    expect(await protectedAction()).toEqual({
      ok: true,
      content: PROTECTED_CONTENT,
    });
  });
  it.each([
    [401, "no_session"],
    [200, "no_grant"],
    [200, "revoked"],
    [503, "unavailable"],
  ])("%s %sではRouteとActionが本文を返さない", async (status, reason) => {
    api({ entitled: false, reason }, status as number);
    const response = await dataRoute();
    expect(response.status).toBe(
      reason === "unavailable" ? 503 : reason === "no_session" ? 401 : 403,
    );
    expect(await response.text()).not.toContain(PROTECTED_CONTENT);
    expect(await protectedAction()).toEqual({ ok: false, reason });
  });
  it("通信障害でも本文を返さない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("通信失敗");
      }),
    );
    expect((await dataRoute()).status).toBe(503);
    const html = await page();
    expect(html).not.toContain(PROTECTED_CONTENT);
    expect(html).toContain("時間をおいて再試行してください");
  });
});

describe("enter_urlへのリダイレクトと停止条件", () => {
  it("拒否されたらページの入口でenter_urlへリダイレクトする", async () => {
    api({ entitled: false, reason: "no_grant", enter_url: enterUrl });
    await expect(page()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectMock).toHaveBeenCalledWith(enterUrl);
  });
  it("ハンドオフ直後の印があればリダイレクトせず拒否を表示する", async () => {
    state.cookies.set("cozeni_handoff", "invalid_code");
    api({ entitled: false, reason: "no_grant", enter_url: enterUrl });
    const html = await page();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(html).toContain("購入権限がありません");
    expect(html).not.toContain(PROTECTED_CONTENT);
  });
  it("交換障害の印なら、再入場ではなく障害として案内する", async () => {
    state.cookies.delete("cozeni_customer");
    state.cookies.set("cozeni_handoff", "unavailable");
    api({ entitled: false, reason: "no_session", enter_url: enterUrl }, 401);
    const html = await page();
    expect(html).toContain("時間をおいて再試行してください");
    expect(html).not.toContain("再入場");
  });
  it("Route HandlerとServer Actionはenter_urlがあってもリダイレクトしない", async () => {
    api({ entitled: false, reason: "no_session", enter_url: enterUrl }, 401);
    expect(await (await dataRoute()).json()).toEqual({
      error: "no_session",
      enter_url: enterUrl,
    });
    expect(await protectedAction()).toEqual({
      ok: false,
      reason: "no_session",
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("購入者ポータルへのボタン", () => {
  const portal = `https://checkout.cozeni.net/portal/${CREATOR_ID}`;
  it("押されたときに発行したリンクへ302で送る", async () => {
    const url = `${portal}?cozeni_portal_code=${"c3".repeat(32)}`;
    api({ url });
    const response = await portalRoute();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(url);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("このサイトで入場していなければ、コード無しのポータルへ送る", async () => {
    api(
      { error: { code: "no_session", message: "x", request_id: "req_1" } },
      401,
    );
    const response = await portalRoute();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(portal);
  });
  it("発行できなければ503で、どこへも送らない", async () => {
    api(
      { error: { code: "unavailable", message: "x", request_id: "req_1" } },
      503,
    );
    const response = await portalRoute();
    expect(response.status).toBe(503);
    expect(response.headers.has("location")).toBe(false);
  });
});

describe("proxyと配信設定", () => {
  it("proxyがcozeni_codeを交換し、コードを除いたURLへ戻す", async () => {
    api({ token: "buyer.jwt.token" });
    const response = await proxy(
      new Request("https://evil.example/members?cozeni_code=once"),
    );
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe(
      "https://creator.example/members",
    );
  });
  it("proxyは静的ファイルを除き、保護ページを対象にする", () => {
    const [matcher] = config.matcher;
    const pattern = new RegExp(`^${matcher}$`);
    expect(pattern.test("/members")).toBe(true);
    expect(pattern.test("/_next/static/chunk.js")).toBe(false);
  });
  it("静的配信にキャッシュ禁止を適用せず、保護ページには適用する", async () => {
    const rules = await nextConfig.headers?.();
    expect(
      rules
        ?.find((rule) => rule.source === "/:path*")
        ?.headers.some((header) => header.key === "Cache-Control"),
    ).toBe(false);
    expect(
      rules?.find((rule) => rule.source === "/members/:path*")?.headers,
    ).toContainEqual({
      key: "Cache-Control",
      value: "private, no-store, max-age=0",
    });
  });
});
