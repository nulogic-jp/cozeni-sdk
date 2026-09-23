import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  token: "valid.token.jwt" as string | undefined,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { value: state.token } : undefined),
  }),
}));
// next/navigationのredirect()は本来Next.jsの制御フロー例外を投げる。テストでは
// 呼び出し先URLを記録しつつ、同じく例外を投げて呼び出し元のcatchの挙動を検証する。
const redirectMock = vi.hoisted(() =>
  vi.fn((url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as Error & { digest: string }).digest =
      `NEXT_REDIRECT;push;${url};307;`;
    throw error;
  }),
);
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

import { GET as dataRoute } from "../app/api/protected/route";
import { POST as clearRoute } from "../app/cozeni/clear/route";
import { GET as handoffRoute } from "../app/cozeni/handoff/route";
import { protectedAction } from "../app/members/actions";
import Members from "../app/members/page";
import { protectedData } from "../lib/cozeni";
import nextConfig from "../next.config";

const secret = "購入者限定の秘密本文";
beforeEach(() => {
  state.token = "valid.token.jwt";
  redirectMock.mockClear();
  vi.stubEnv("COZENI_API_ORIGIN", "http://localhost:8787");
  vi.stubEnv("COZENI_SITE_ORIGIN", "https://creator.example");
  vi.stubEnv("COZENI_PRODUCT_ID", "prd_test");
  vi.stubEnv("COZENI_PROTECTED_CONTENT", secret);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function api(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}
describe("Next.jsの各入口で認可", () => {
  it("許可された購入者だけにデータ・Route・Actionを返す", async () => {
    api({ entitled: true });
    expect(await protectedData()).toEqual({ content: secret });
    expect(await (await dataRoute()).json()).toEqual({ content: secret });
    expect(await protectedAction()).toEqual({ ok: true, content: secret });
  });
  it.each([
    [401, "no_session"],
    [200, "no_grant"],
    [200, "revoked"],
    [503, "unavailable"],
  ])("%s %sを直接呼出でも拒否する", async (status, reason) => {
    api({ entitled: false, reason }, status as number);
    await expect(protectedData()).rejects.toThrow();
    const response = await dataRoute();
    expect(response.status).toBe(
      reason === "unavailable" ? 503 : reason === "no_session" ? 401 : 403,
    );
    expect(await response.text()).not.toContain(secret);
    const action = await protectedAction();
    expect(action).toEqual({ ok: false, reason });
    expect(JSON.stringify(action)).not.toContain(secret);
  });
  it("通信障害でも漏出しない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("通信失敗");
      }),
    );
    expect((await dataRoute()).status).toBe(503);
    expect(await protectedAction()).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
  it("Cookieなしでも権利確認APIを呼び、Cookieヘッダーを送らない", async () => {
    state.token = undefined;
    api({ entitled: false, reason: "no_session" }, 401);
    expect(await protectedAction()).toEqual({
      ok: false,
      reason: "no_session",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      new Headers(
        (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.headers,
      ).has("Cookie"),
    ).toBe(false);
  });
});
describe("Next.jsのハンドオフとCookie消去", () => {
  it("任意Hostに戻さずコードを除去し、HttpOnly Cookieを設定する", async () => {
    api({ token: "valid.token.jwt" });
    const response = await handoffRoute(
      new Request("https://evil.example/cozeni/handoff?cozeni_code=code"),
    );
    expect(response.status).toBe(303);
    // ハンドオフ成功直後を示す秘密を含まない印(cozeni_handoff)が付く。
    // 無限リダイレクトの停止条件としてpage側が使う。
    expect(response.headers.get("location")).toBe(
      "https://creator.example/members?cozeni_handoff=1",
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it.each(["期限切れ", "再使用"])(
    "%sコード失敗はコードを消し再交換ループを起こさない",
    async () => {
      api(
        {
          error: { code: "invalid_code", request_id: "r", message: "invalid" },
        },
        400,
      );
      const response = await handoffRoute(
        new Request("https://evil.example/cozeni/handoff?cozeni_code=code"),
      );
      expect(response.headers.get("location")).toBe(
        "https://creator.example/members?cozeni_error=invalid_code",
      );
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("消去後も信頼originを維持し別OriginのPOSTを拒否する", async () => {
    const response = await clearRoute(
      new Request("https://evil.example/cozeni/clear", {
        method: "POST",
        headers: { Origin: "https://creator.example" },
      }),
    );
    expect(response.headers.get("location")).toBe(
      "https://creator.example/members",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(
      (
        await clearRoute(
          new Request("https://creator.example/cozeni/clear", {
            method: "POST",
            headers: { Origin: "https://evil.example" },
          }),
        )
      ).status,
    ).toBe(403);
  });
});

describe("Cookie消去フォームのOrigin回帰", () => {
  it("ページはoriginだけを送信し、callbackは参照元を送信しない", async () => {
    const rules = await nextConfig.headers?.();
    expect(
      rules?.find((rule) => rule.source === "/:path*")?.headers,
    ).toContainEqual({ key: "Referrer-Policy", value: "strict-origin" });
    api({ token: "valid.token.jwt" });
    const callback = await handoffRoute(
      new Request("https://creator.example/cozeni/handoff?cozeni_code=code"),
    );
    expect(callback.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
  it.each([undefined, "null", "https://evil.example"])(
    "不明または別サイトのOrigin %sを許可しない",
    async (origin) => {
      const response = await clearRoute(
        new Request("https://creator.example/cozeni/clear", {
          method: "POST",
          headers: origin ? { Origin: origin } : undefined,
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.has("Set-Cookie")).toBe(false);
    },
  );
});

describe("レビュー指摘の回帰", () => {
  async function page(query: Record<string, string> = {}) {
    return renderToStaticMarkup(
      await Members({ searchParams: Promise.resolve(query) }),
    );
  }
  it.each(["invalid_code", "unavailable"])(
    "%s交換失敗後も既存セッションを再認可する",
    async (reason) => {
      api({ entitled: true });
      const html = await page({ cozeni_error: reason });
      expect(html).toContain(secret);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it("交換障害後にセッションがなければ障害案内を維持する", async () => {
    state.token = undefined;
    const html = await page({ cozeni_error: "unavailable" });
    expect(html).toContain("時間をおいて再試行してください");
    expect(html).not.toContain(secret);
    expect(html).not.toContain("メール認証で再入場");
  });
  it("交換障害で既存Cookieを消去しない", async () => {
    api({ error: { code: "unavailable" } }, 503);
    const response = await handoffRoute(
      new Request(
        "https://evil.example/cozeni/handoff?cozeni_code=secret-code",
      ),
    );
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.get("location")).toBe(
      "https://creator.example/members?cozeni_error=unavailable",
    );
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
  it.each([
    "COZENI_API_ORIGIN",
    "COZENI_PRODUCT_ID",
    "COZENI_PROTECTED_CONTENT",
  ])("%s設定欠落を秘密なしで診断し、各入口は拒否する", async (name) => {
    api({ entitled: true });
    vi.stubEnv(name, "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await dataRoute();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"unavailable"}');
    expect(await protectedAction()).toEqual({
      ok: false,
      reason: "unavailable",
    });
    const html = await page();
    expect(html).not.toContain(secret);
    expect(html).toContain("時間をおいて再試行してください");
    expect(log.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(log.mock.calls)).toContain(name);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
  it.each(["COZENI_API_ORIGIN", "COZENI_SITE_ORIGIN"])(
    "%s設定欠落をcallbackでも診断しコードを返さない",
    async (name) => {
      vi.stubEnv(name, "");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const response = await handoffRoute(
        new Request(
          "https://evil.example/cozeni/handoff?cozeni_code=secret-code",
        ),
      );
      expect(response.status).toBe(name === "COZENI_SITE_ORIGIN" ? 503 : 303);
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(response.headers.get("location") ?? "").not.toContain(
        "evil.example",
      );
      expect(response.headers.get("location") ?? "").not.toContain(
        "secret-code",
      );
      expect(JSON.stringify(log.mock.calls)).toContain(name);
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret-code");
    },
  );
});

describe("設定診断と失敗後の認可の追加境界", () => {
  it.each(["no_grant", "revoked", "unavailable"])(
    "古いコードがあっても現在の%sを無視しない",
    async (reason) => {
      api({ entitled: false, reason }, reason === "unavailable" ? 503 : 200);
      const html = renderToStaticMarkup(
        await Members({
          searchParams: Promise.resolve({ cozeni_error: "invalid_code" }),
        }),
      );
      expect(html).not.toContain(secret);
      expect(html).not.toContain("メール認証で再入場");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("不正なAPI設定値をログ・応答へ出さず設定名だけ記録する", async () => {
    vi.stubEnv("COZENI_API_ORIGIN", "https://user:api-secret@example.com/path");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await dataRoute();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("api-secret");
    expect(JSON.stringify(log.mock.calls)).toContain("COZENI_API_ORIGIN");
    expect(JSON.stringify(log.mock.calls)).not.toContain("api-secret");
  });
  it("自サイト設定欠落時はCookieを消さず外部Hostにも転送しない", async () => {
    vi.stubEnv("COZENI_SITE_ORIGIN", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await clearRoute(
      new Request("https://evil.example/cozeni/clear", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(JSON.stringify(log.mock.calls)).toContain("COZENI_SITE_ORIGIN");
  });
  it("転送先設定欠落をページでも秘密なしで診断する", async () => {
    vi.stubEnv("COZENI_SITE_ORIGIN", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToStaticMarkup(
      await Members({
        searchParams: Promise.resolve({ cozeni_code: "secret-code" }),
      }),
    );
    expect(html).toContain("時間をおいて再試行してください");
    expect(html).not.toContain("secret-code");
    expect(JSON.stringify(log.mock.calls)).toContain("COZENI_SITE_ORIGIN");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-code");
  });
});

describe("enter_urlへの自動リダイレクト", () => {
  const enterUrl = "https://checkout.example/enter?product_id=prd_test";
  async function page(query: Record<string, string> = {}) {
    return renderToStaticMarkup(
      await Members({ searchParams: Promise.resolve(query) }),
    );
  }
  it("enter_urlがある拒否はpageの入口でenter_urlへredirectする", async () => {
    api({ entitled: false, reason: "no_grant", enter_url: enterUrl }, 200);
    await expect(page()).rejects.toThrow();
    expect(redirectMock).toHaveBeenCalledWith(enterUrl);
  });
  it("unavailableはenter_urlがあってもredirectしない", async () => {
    // unavailableの契約にenter_urlは付かないため、通常はこの組み合わせは
    // 発生しない。仮に付いていてもredirectしないことを確認する。
    api({ entitled: false, reason: "unavailable", enter_url: enterUrl }, 503);
    const html = await page();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(html).toContain("時間をおいて再試行してください");
    expect(html).not.toContain(secret);
  });
  it("enter_urlが無い拒否はredirectせずサイト内の拒否表示に留める", async () => {
    api({ entitled: false, reason: "no_grant" }, 200);
    const html = await page();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(html).toContain("この商品の購入権限がありません");
    expect(html).not.toContain(secret);
  });
  it("ハンドオフのコード交換直後（cozeni_error付き）はenter_urlがあってもredirectしない", async () => {
    api({ entitled: false, reason: "no_session", enter_url: enterUrl }, 401);
    const html = await page({ cozeni_error: "invalid_code" });
    expect(redirectMock).not.toHaveBeenCalled();
    expect(html).toContain("購入時のメールアドレスで再入場してください");
    expect(html).not.toContain(secret);
  });
  it("Route Handlerはenter_urlがあってもredirectせずJSON本文へ含める", async () => {
    api({ entitled: false, reason: "no_grant", enter_url: enterUrl }, 200);
    const response = await dataRoute();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "no_grant",
      enter_url: enterUrl,
    });
  });
  it("Server Actionはenter_urlがあってもredirectせず理由だけを返す", async () => {
    api({ entitled: false, reason: "no_grant", enter_url: enterUrl }, 200);
    expect(await protectedAction()).toEqual({ ok: false, reason: "no_grant" });
    expect(redirectMock).not.toHaveBeenCalled();
  });
  it("productIdと一致しないenter_urlはredirectしない", async () => {
    api(
      {
        entitled: false,
        reason: "no_grant",
        enter_url: "https://checkout.example/enter?product_id=prd_other",
      },
      200,
    );
    const html = await page();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(html).toContain("この商品の購入権限がありません");
    expect(html).not.toContain(secret);
  });
  it("ハンドオフ成功直後の印（cozeni_handoff）はenter_urlがあってもredirectしない", async () => {
    api({ entitled: false, reason: "no_grant", enter_url: enterUrl }, 200);
    const html = await page({ cozeni_handoff: "1" });
    expect(redirectMock).not.toHaveBeenCalled();
    expect(html).toContain("この商品の購入権限がありません");
    expect(html).not.toContain(secret);
  });
  it("ハンドオフ成功直後の印が付いた状態で権利があれば、印を外したURLへ正規化する", async () => {
    api({ entitled: true });
    await expect(page({ cozeni_handoff: "1" })).rejects.toThrow();
    expect(redirectMock).toHaveBeenCalledWith(
      "https://creator.example/members",
    );
  });
  it("cozeni_error・cozeni_handoffが重複クエリ（string[]）でも停止条件として扱う", async () => {
    api({ entitled: false, reason: "no_grant", enter_url: enterUrl }, 200);
    const html = renderToStaticMarkup(
      await Members({
        searchParams: Promise.resolve({
          cozeni_error: ["invalid_code", "invalid_code"],
        }),
      }),
    );
    expect(redirectMock).not.toHaveBeenCalled();
    expect(html).not.toContain(secret);
  });
  it("重複したcozeni_code（string[]）は無効なコードとして扱いhandoffへ転送しない", async () => {
    await expect(
      Members({
        searchParams: Promise.resolve({
          cozeni_code: ["a", "b"],
        }),
      }),
    ).rejects.toThrow();
    expect(redirectMock).toHaveBeenCalledWith(
      "https://creator.example/members?cozeni_error=invalid_code",
    );
  });
});
