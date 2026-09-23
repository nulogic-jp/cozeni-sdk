import { describe, expect, it, vi } from "vitest";
import {
  CozeniError,
  clearCustomerCookie,
  createCustomerClient,
  createManagementClient,
  customerCookie,
  enterRedirectResponse,
  enterRedirectUrl,
  trustedSiteUrl,
} from "../src/index.js";

const apiOrigin = "http://localhost:8787";
const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
describe("管理API", () => {
  it("認証・冪等キー・キャッシュを設定し本文なしPUTを送る", async () => {
    const fetch = vi.fn().mockImplementation(async () => ok({ id: "p" }));
    const client = createManagementClient({
      apiOrigin,
      apiKey: "secret",
      fetch,
    });
    await client.products.create(
      {
        name: "本",
        price_jpy: 3000,
        access_url: "https://site.example/members",
      },
      { idempotencyKey: "saved-key" },
    );
    const call = fetch.mock.calls[0];
    if (!call) throw new Error("リクエストが記録されていません。");
    const [url, init] = call;
    expect(url).toBe(`${apiOrigin}/external/v1/products`);
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer secret",
    );
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("saved-key");
    expect(init).toMatchObject({
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
    });
    await client.checkoutLinks.ensure("p");
    expect(fetch.mock.calls[1]?.[1].body).toBeUndefined();
  });
  it("必須冪等キーを送信前に拒否する", async () => {
    const fetch = vi.fn();
    const client = createManagementClient({
      apiOrigin,
      apiKey: "secret",
      fetch,
    });
    await expect(
      client.products.create(
        { name: "本", price_jpy: 3000, access_url: "https://site.example" },
        { idempotencyKey: "" },
      ),
    ).rejects.toThrow(CozeniError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("エラーに秘密・応答生本文を保持しない", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "rate_limited",
            message: "leaked secret",
            request_id: "req_1",
          },
        }),
        { status: 429, headers: { "Retry-After": "10" } },
      ),
    );
    const client = createManagementClient({
      apiOrigin,
      apiKey: "secret",
      fetch,
    });
    try {
      await client.account.get();
      throw new Error("到達不可");
    } catch (error) {
      expect(error).toMatchObject({
        status: 429,
        code: "rate_limited",
        requestId: "req_1",
        retryAfterSeconds: 10,
      });
      expect(String(error)).not.toContain("secret");
    }
  });
  it("terms_consent_requiredをinvalid_responseへ潰さず区別する", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "terms_consent_required",
            message: "規約改定後に未同意です。",
            request_id: "req_terms",
          },
        }),
        { status: 403 },
      ),
    );
    const client = createManagementClient({
      apiOrigin,
      apiKey: "secret",
      fetch,
    });
    await expect(client.account.get()).rejects.toMatchObject({
      status: 403,
      code: "terms_consent_required",
      requestId: "req_terms",
    });
  });
});
describe("購入者API", () => {
  it("購入者Cookieだけを転送しAPIキーを要求しない", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ entitled: true }));
    const result = await createCustomerClient({
      apiOrigin,
      fetch,
    }).checkEntitlement({
      productId: "p",
      cookieHeader: "auth=secret; cozeni_customer=jwt.value.test; other=x",
    });
    expect(result).toEqual({ entitled: true });
    expect(new Headers(fetch.mock.calls[0]?.[1].headers).get("Cookie")).toBe(
      "cozeni_customer=jwt.value.test",
    );
    expect(
      new Headers(fetch.mock.calls[0]?.[1].headers).has("Authorization"),
    ).toBe(false);
  });
  it.each([
    [200, { entitled: false, reason: "no_grant" }],
    [200, { entitled: false, reason: "revoked" }],
    [401, { entitled: false, reason: "no_session" }],
    [503, { entitled: false, reason: "unavailable" }],
  ])("拒否契約を維持する %s", async (status, body) => {
    const client = createCustomerClient({
      apiOrigin,
      fetch: vi.fn().mockResolvedValue(ok(body, status as number)),
    });
    expect(
      await client.checkEntitlement({
        productId: "p",
        cookieHeader: "cozeni_customer=a.b.c",
      }),
    ).toEqual(body);
  });
  it.each([
    ok({ entitled: true }, 503),
    ok({ entitled: "true" }),
    new Response("壊れたJSON"),
    ok({ entitled: true }, 302),
  ])("契約外の応答を許可しない", async (response) => {
    expect(
      await createCustomerClient({
        apiOrigin,
        fetch: vi.fn().mockResolvedValue(response),
      }).checkEntitlement({
        productId: "p",
        cookieHeader: "cozeni_customer=a.b.c",
      }),
    ).toEqual({ entitled: false, reason: "unavailable" });
  });
  it("通信障害と期限超過で拒否する", async () => {
    const client = createCustomerClient({
      apiOrigin,
      fetch: vi.fn().mockRejectedValue(new Error("secret")),
    });
    expect(
      await client.checkEntitlement({
        productId: "p",
        cookieHeader: "cozeni_customer=a.b.c",
      }),
    ).toEqual({ entitled: false, reason: "unavailable" });
  });
  it("Cookie無しでも権利確認APIを呼ぶ（未認証がこのAPIの主要な入口のため）", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(ok({ entitled: false, reason: "no_session" }, 401));
    const client = createCustomerClient({ apiOrigin, fetch });
    expect(await client.checkEntitlement({ productId: "p" })).toEqual({
      entitled: false,
      reason: "no_session",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("Cookie")).toBe(
      false,
    );
  });
  it("不正Cookieと重複Cookieは送信せず、Cookie無しとしてAPIを呼ぶ", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(ok({ entitled: false, reason: "no_session" }, 401));
    const client = createCustomerClient({ apiOrigin, fetch });
    expect(
      await client.checkEntitlement({
        productId: "p",
        cookieHeader: "cozeni_customer=a; cozeni_customer=b",
      }),
    ).toEqual({ entitled: false, reason: "no_session" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("Cookie")).toBe(
      false,
    );
  });
  it("productId未指定・上限超過（200文字）は呼び出し前にno_grantとして拒否する", async () => {
    const fetch = vi.fn();
    const client = createCustomerClient({ apiOrigin, fetch });
    for (const productId of ["", "p".repeat(201)]) {
      expect(await client.checkEntitlement({ productId })).toEqual({
        entitled: false,
        reason: "no_grant",
      });
    }
    // API障害（unavailable）と混同されないよう、契約上の入力違反はAPIを呼ばずに
    // 判定する。200文字ちょうどは呼び出しを許可する。
    expect(fetch).not.toHaveBeenCalled();
    await client.checkEntitlement({
      productId: "p".repeat(200),
      cookieHeader: "cozeni_customer=a.b.c",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("enter_urlは構造検証（https必須・pathname固定・product_id一致・fragment無し）を通ったものだけ採用する", async () => {
    const productId = "prd_0123456789abcdef0123456789abcdef";
    const validUrl = `https://checkout.example/enter?product_id=${productId}`;
    const cases: [unknown, string | undefined][] = [
      [validUrl, validUrl],
      // httpはloopbackだけ許可する。
      [
        `http://127.0.0.1:8787/enter?product_id=${productId}`,
        `http://127.0.0.1:8787/enter?product_id=${productId}`,
      ],
      [`http://checkout.example/enter?product_id=${productId}`, undefined],
      ["javascript:alert(1)", undefined],
      [
        `https://user:pass@checkout.example/enter?product_id=${productId}`,
        undefined,
      ],
      ["not a url", undefined],
      // pathnameが/enter固定でない。
      [`https://checkout.example/other?product_id=${productId}`, undefined],
      // クエリがproduct_id以外を含む、または複数ある。
      [`https://checkout.example/enter?product_id=${productId}&x=1`, undefined],
      // product_idが同じ値でも重複していれば拒否する。
      [
        `https://checkout.example/enter?product_id=${productId}&product_id=${productId}`,
        undefined,
      ],
      // fragmentを含む。
      [`https://checkout.example/enter?product_id=${productId}#top`, undefined],
      // product_idが問い合わせたproductIdと一致しない。
      ["https://checkout.example/enter?product_id=prd_other", undefined],
      [undefined, undefined],
      [42, undefined],
    ];
    for (const [enterUrlInput, expected] of cases) {
      const body: Record<string, unknown> = {
        entitled: false,
        reason: "no_grant",
      };
      if (enterUrlInput !== undefined) body.enter_url = enterUrlInput;
      const client = createCustomerClient({
        apiOrigin,
        fetch: vi.fn().mockResolvedValue(ok(body)),
      });
      const result = await client.checkEntitlement({
        productId,
        cookieHeader: "cozeni_customer=a.b.c",
      });
      expect(result).toEqual(
        expected
          ? { entitled: false, reason: "no_grant", enterUrl: expected }
          : { entitled: false, reason: "no_grant" },
      );
    }
  });
  it("unavailableにはenter_urlが付かない契約を維持する", async () => {
    const client = createCustomerClient({
      apiOrigin,
      fetch: vi.fn().mockResolvedValue(
        ok(
          {
            entitled: false,
            reason: "unavailable",
            enter_url: "https://checkout.example/enter?product_id=prd_x",
          },
          503,
        ),
      ),
    });
    // 503はunavailable固定契約のため、余分なenter_urlが混入しても無視する。
    expect(
      await client.checkEntitlement({
        productId: "p",
        cookieHeader: "cozeni_customer=a.b.c",
      }),
    ).toEqual({ entitled: false, reason: "unavailable" });
  });
  it("コードの自動再送をしない", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        ok(
          { error: { code: "invalid_code", message: "失敗", request_id: "r" } },
          400,
        ),
      );
    await expect(
      createCustomerClient({ apiOrigin, fetch }).exchangeHandoff("expired"),
    ).rejects.toMatchObject({ code: "invalid_code" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
describe("enter_urlへのリダイレクト判定（フレームワーク非依存ヘルパー）", () => {
  const productId = "prd_x";
  const enterUrl = `https://checkout.example/enter?product_id=${productId}`;
  const denied = {
    entitled: false as const,
    reason: "no_grant" as const,
    enterUrl,
  };
  it("enter_urlがある拒否だけをリダイレクト対象にする", () => {
    expect(enterRedirectUrl(denied, productId)?.href).toBe(enterUrl);
    const response = enterRedirectResponse(denied, productId);
    expect(response?.status).toBe(303);
    expect(response?.headers.get("Location")).toBe(enterUrl);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response?.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
  it("手で組み立てたEntitlementでも構造検証を再実行する（productId不一致は却下）", () => {
    expect(enterRedirectUrl(denied, "prd_other")).toBeUndefined();
    expect(enterRedirectResponse(denied, "prd_other")).toBeUndefined();
  });
  it("手で組み立てたEntitlementの不正なenterUrl（javascript:等）はredirect()やLocationに届かない", () => {
    const malicious = {
      entitled: false as const,
      reason: "no_grant" as const,
      enterUrl: "javascript:alert(document.cookie)",
    };
    expect(enterRedirectUrl(malicious, productId)).toBeUndefined();
    expect(enterRedirectResponse(malicious, productId)).toBeUndefined();
  });
  it("許可済みはリダイレクト対象にしない", () => {
    expect(enterRedirectUrl({ entitled: true }, productId)).toBeUndefined();
    expect(
      enterRedirectResponse({ entitled: true }, productId),
    ).toBeUndefined();
  });
  it("unavailableはenter_urlを持てないためリダイレクト対象にしない", () => {
    const unavailable = {
      entitled: false as const,
      reason: "unavailable" as const,
    };
    expect(enterRedirectUrl(unavailable, productId)).toBeUndefined();
    expect(enterRedirectResponse(unavailable, productId)).toBeUndefined();
  });
  it("enter_urlが無い拒否はリダイレクト対象にしない", () => {
    const noUrl = { entitled: false as const, reason: "no_session" as const };
    expect(enterRedirectUrl(noUrl, productId)).toBeUndefined();
    expect(enterRedirectResponse(noUrl, productId)).toBeUndefined();
  });
});
describe("自サイト境界", () => {
  it("信頼済みorigin以外への遷移を拒否する", () => {
    expect(trustedSiteUrl("https://site.example", "/members").href).toBe(
      "https://site.example/members",
    );
    expect(() =>
      trustedSiteUrl("https://site.example", "//evil.example"),
    ).toThrow();
    expect(() =>
      createCustomerClient({ apiOrigin: "https://user:password@api.example" }),
    ).toThrow();
    expect(() =>
      createCustomerClient({ apiOrigin: "http://api.example" }),
    ).toThrow();
  });
  it("Cookieは自サイトでHttpOnly・Lax、HTTPSでSecureになる", () => {
    expect(customerCookie("a.b.c", "https://site.example")).toBe(
      "cozeni_customer=a.b.c; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure",
    );
    expect(clearCustomerCookie("https://site.example")).toContain(
      "Max-Age=0; Secure",
    );
    expect(customerCookie("a.b.c", "http://127.0.0.1:3000")).not.toContain(
      "Secure",
    );
  });
});

describe("通信と入力の追加境界", () => {
  it("タイムアウトで要求を中断し、認可を許可しない", async () => {
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("中断された要求")),
            { once: true },
          );
        }),
    );
    const client = createCustomerClient({ apiOrigin, fetch, timeoutMs: 5 });
    expect(
      await client.checkEntitlement({
        productId: "p",
        cookieHeader: "cozeni_customer=a.b.c",
      }),
    ).toEqual({ entitled: false, reason: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("ハンドオフではキーもCookieも送らない", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ token: "a.b.c" }));
    expect(
      await createCustomerClient({ apiOrigin, fetch }).exchangeHandoff("once"),
    ).toEqual({ token: "a.b.c" });
    const headers = new Headers(fetch.mock.calls[0]?.[1].headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
  });
  it("認証先のpath/query混入と相対パスのIDを拒否する", () => {
    expect(() =>
      createCustomerClient({ apiOrigin: "https://api.example/path" }),
    ).toThrow(CozeniError);
    expect(() =>
      createCustomerClient({ apiOrigin: "https://api.example/?secret=1" }),
    ).toThrow(CozeniError);
    const fetch = vi.fn();
    expect(() =>
      createManagementClient({
        apiOrigin,
        apiKey: "secret",
        fetch,
      }).products.get(".."),
    ).toThrow(CozeniError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("エラーrequest_idの秘密混入防止", () => {
  it.each([
    "cozeni_sk_not_for_logs",
    "0000000000000000000000000000000000000000000000000000000000000000",
  ])("要求IDに秘密らしい値 %s が混入しても保持しない", async (secret) => {
    const fetch = vi.fn().mockResolvedValue(
      ok(
        {
          error: {
            code: "invalid_code",
            message: secret,
            request_id: secret,
          },
        },
        400,
      ),
    );
    const client = createCustomerClient({ apiOrigin, fetch });
    try {
      await client.exchangeHandoff("once");
      throw new Error("成功してはいけません。");
    } catch (error) {
      expect(error).toBeInstanceOf(CozeniError);
      expect(error).toMatchObject({
        code: "invalid_code",
        requestId: undefined,
      });
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});
