import { describe, expect, it, vi } from "vitest";
import {
  CozeniError,
  clearCustomerCookie,
  createCustomerClient,
  createManagementClient,
  customerCookie,
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
  it("不正Cookieと重複Cookieは送信しない", async () => {
    const fetch = vi.fn();
    const client = createCustomerClient({ apiOrigin, fetch });
    expect(
      await client.checkEntitlement({
        productId: "p",
        cookieHeader: "cozeni_customer=a; cozeni_customer=b",
      }),
    ).toEqual({ entitled: false, reason: "no_session" });
    expect(fetch).not.toHaveBeenCalled();
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
