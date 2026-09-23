export type Scope =
  | "products:read"
  | "products:write"
  | "checkout_links:read"
  | "checkout_links:write";
export type SalesRejectionReasonCode =
  | "tokushoho_missing_contact"
  | "tokushoho_unreachable"
  | "website_unreachable"
  | "description_insufficient"
  | "prohibited_content"
  | "other";
export type SalesWarning = "payouts_disabled";
// review_rejectedだけがrejection詳細を持つ判別union。codeで種別を絞り込める。
export type SalesBlocker =
  | {
      code:
        | "review_not_submitted"
        | "review_pending"
        | "stripe_not_connected"
        | "stripe_onboarding_incomplete"
        | "stripe_verification_pending";
      action_url: string;
    }
  | {
      code: "review_rejected";
      action_url: string;
      rejection: {
        reason_code: SalesRejectionReasonCode;
        note: string | null;
      };
    };
export interface AccountSales {
  can_sell: boolean;
  blockers: SalesBlocker[];
  warnings: SalesWarning[];
}
export interface Account {
  creator_id: string;
  api_key_id: string;
  scopes: Scope[];
  environment: string;
  api_version: "v1";
  // 旧バージョンのAPIはsalesを返さないため任意項目にする。
  sales?: AccountSales;
}
export interface CreateProduct {
  name: string;
  price_jpy: number;
  access_url: string;
}
export type UpdateProduct = Partial<CreateProduct>;
export interface Product extends CreateProduct {
  id: string;
  currency: "jpy";
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}
export interface ProductList {
  items: Product[];
  next_cursor: string | null;
}
export interface CheckoutLink {
  id: string;
  product_id: string;
  url: string;
  disabled: boolean;
}
export type Entitlement =
  | { entitled: true }
  | {
      entitled: false;
      reason: "no_grant" | "revoked" | "no_session";
      // 購入者を再入場させる画面へのURL。validEnterUrl()の構造検証を通過した
      // ときだけ含む。手で組み立てたEntitlementを渡す場合も、enterRedirectUrl()が
      // 同じ検証を再度行うため、ここに不正な値が入っていても実害はない。
      enterUrl?: string;
    }
  | { entitled: false; reason: "unavailable" };
export interface ClientOptions {
  apiOrigin: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export interface ManagementClientOptions extends ClientOptions {
  apiKey: string;
}

const knownCodes = new Set([
  "invalid_input",
  "invalid_code",
  "unauthorized",
  "insufficient_scope",
  "product_not_found",
  "checkout_link_not_found",
  "idempotency_conflict",
  "product_archived",
  "checkout_link_disabled",
  "rate_limited",
  "internal",
  "unavailable",
  "invalid_response",
  "network_error",
  "timeout",
]);
export class CozeniError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  constructor(
    code: string,
    status = 0,
    requestId?: string,
    retryAfterSeconds?: number,
  ) {
    super(
      "Cozeniへの要求を完了できませんでした。codeとstatusを確認してください。",
    );
    this.name = "CozeniError";
    this.code = knownCodes.has(code) ? code : "invalid_response";
    this.status = status;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
function serverOnly() {
  if (typeof window !== "undefined") throw new CozeniError("invalid_input");
}
function origin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CozeniError("invalid_input");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new CozeniError("invalid_input");
  return url;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * enter_url の構造検証。API応答の取り込み時（checkEntitlement）と
 * enterRedirectUrl()（手で組み立てたEntitlementを渡す経路）の両方で必ず通す
 * 共通関数。SDKの設定にweb originを足さない方針のため、許可originの列挙ではなく
 * 構造で縛る。
 *
 * - httpsが必須。httpはlocalhost・127.0.0.1・[::1]のloopbackだけ許可（開発用）
 * - userinfo（ユーザー名・パスワード）を含まない
 * - pathnameは"/enter"固定
 * - クエリは"product_id"の1個だけで、値は問い合わせたproductIdと完全一致する
 * - fragmentを含まない
 *
 * いずれかに反する場合はundefined（採用しない＝リダイレクトしない）。
 */
function validEnterUrl(value: unknown, productId: string): URL | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/enter" ||
    url.hash ||
    [...url.searchParams.keys()].length !== 1 ||
    url.searchParams.get("product_id") !== productId
  )
    return undefined;
  return url;
}
function transport(options: ClientOptions, apiKey?: string) {
  serverOnly();
  const base = origin(options.apiOrigin).origin;
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new CozeniError("invalid_input");
  const request = options.fetch ?? globalThis.fetch;
  return async (
    path: string,
    method: string,
    body?: unknown,
    extra?: Record<string, string>,
  ) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers({ Accept: "application/json", ...extra });
      if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const response = await request(`${base}/external/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
      });
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new CozeniError("invalid_response", response.status);
      }
      return { response, data };
    } catch (error) {
      if (error instanceof CozeniError) throw error;
      // fetchの例外やURLを保持しない。コード・JWT・APIキーのログ混入を防ぐ。
      throw new CozeniError(
        controller.signal.aborted ? "timeout" : "network_error",
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
function failure(response: Response, data: unknown): CozeniError {
  const error = record(data) && record(data.error) ? data.error : {};
  const code = typeof error.code === "string" ? error.code : "invalid_response";
  const requestId =
    typeof error.request_id === "string" &&
    /^req_[a-zA-Z0-9_-]{1,96}$/.test(error.request_id)
      ? error.request_id
      : undefined;
  const retry = response.headers.get("Retry-After");
  return new CozeniError(
    code,
    response.status,
    requestId,
    retry && /^\d{1,8}$/.test(retry) ? Number(retry) : undefined,
  );
}
function identifier(id: string): string {
  if (!id || id.length > 200 || id === "." || id === "..")
    throw new CozeniError("invalid_input");
  return encodeURIComponent(id);
}
export function createManagementClient(options: ManagementClientOptions) {
  if (!options.apiKey || /\s/.test(options.apiKey))
    throw new CozeniError("invalid_input");
  const send = transport(options, options.apiKey);
  async function request<T>(
    path: string,
    method: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<T> {
    const { response, data } = await send(path, method, body, extra);
    if (!response.ok) throw failure(response, data);
    if (!record(data))
      throw new CozeniError("invalid_response", response.status);
    return data as T;
  }
  return {
    account: { get: () => request<Account>("/account", "GET") },
    products: {
      list: (input: { limit?: number; cursor?: string } = {}) => {
        const search = new URLSearchParams();
        if (input.limit !== undefined) search.set("limit", String(input.limit));
        if (input.cursor !== undefined) search.set("cursor", input.cursor);
        return request<ProductList>(
          `/products${search.size ? `?${search}` : ""}`,
          "GET",
        );
      },
      get: (id: string) =>
        request<Product>(`/products/${identifier(id)}`, "GET"),
      create: async (
        input: CreateProduct,
        settings: { idempotencyKey: string },
      ) => {
        if (
          !settings?.idempotencyKey ||
          !/^[\x21-\x7E]{1,128}$/.test(settings.idempotencyKey)
        )
          throw new CozeniError("invalid_input");
        return request<Product>("/products", "POST", input, {
          "Idempotency-Key": settings.idempotencyKey,
        });
      },
      update: (id: string, input: UpdateProduct) =>
        request<Product>(`/products/${identifier(id)}`, "PATCH", input),
    },
    checkoutLinks: {
      get: (productId: string) =>
        request<CheckoutLink>(
          `/products/${identifier(productId)}/checkout-link`,
          "GET",
        ),
      ensure: (productId: string) =>
        request<CheckoutLink>(
          `/products/${identifier(productId)}/checkout-link`,
          "PUT",
        ),
    },
  };
}
function customerToken(cookieHeader?: string): string | undefined {
  const entries =
    cookieHeader
      ?.split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("cozeni_customer=")) ?? [];
  if (entries.length !== 1) return;
  const token = entries[0]?.slice("cozeni_customer=".length);
  return token && /^[a-zA-Z0-9._-]{1,8192}$/.test(token) ? token : undefined;
}
export function createCustomerClient(options: ClientOptions) {
  const send = transport(options);
  return {
    async exchangeHandoff(code: string): Promise<{ token: string }> {
      if (!code || code.length > 128) throw new CozeniError("invalid_input");
      const { response, data } = await send(
        "/customer/handoff/exchange",
        "POST",
        { code },
      );
      if (response.status !== 200) throw failure(response, data);
      if (
        !record(data) ||
        typeof data.token !== "string" ||
        !/^[a-zA-Z0-9._-]{1,8192}$/.test(data.token)
      )
        throw new CozeniError("invalid_response", response.status);
      return { token: data.token };
    },
    async checkEntitlement(input: {
      productId: string;
      cookieHeader?: string;
    }): Promise<Entitlement> {
      // 未認証（Cookie無し）もこのAPIの主要な入口のため、トークン無しでも呼び出す。
      // productIdが空、または契約の上限（200文字）を超える入力は、API障害
      // （unavailable）とは区別できる設定ミスのため、API呼び出し前にno_grant
      // （契約上「未購入または商品不明」を表す）として拒否する。
      if (!input.productId || input.productId.length > 200)
        return { entitled: false, reason: "no_grant" };
      const token = customerToken(input.cookieHeader);
      try {
        const { response, data } = await send(
          "/customer/entitlements/check",
          "POST",
          { product_id: input.productId },
          token ? { Cookie: `cozeni_customer=${token}` } : undefined,
        );
        if (record(data)) {
          if (response.status === 200 && data.entitled === true)
            return { entitled: true };
          if (
            response.status === 200 &&
            data.entitled === false &&
            (data.reason === "no_grant" || data.reason === "revoked")
          ) {
            const enterUrl = validEnterUrl(data.enter_url, input.productId);
            return enterUrl
              ? {
                  entitled: false,
                  reason: data.reason,
                  enterUrl: enterUrl.href,
                }
              : { entitled: false, reason: data.reason };
          }
          if (
            response.status === 401 &&
            data.entitled === false &&
            data.reason === "no_session"
          ) {
            const enterUrl = validEnterUrl(data.enter_url, input.productId);
            return enterUrl
              ? {
                  entitled: false,
                  reason: "no_session",
                  enterUrl: enterUrl.href,
                }
              : { entitled: false, reason: "no_session" };
          }
        }
        return { entitled: false, reason: "unavailable" };
      } catch {
        return { entitled: false, reason: "unavailable" };
      }
    },
  };
}
export function trustedSiteUrl(siteOrigin: string, path: string): URL {
  const base = origin(siteOrigin);
  const result = new URL(path, base);
  if (result.origin !== base.origin || result.username || result.password)
    throw new CozeniError("invalid_input");
  return result;
}
export function customerCookie(token: string, siteOrigin: string): string {
  if (!/^[a-zA-Z0-9._-]{1,8192}$/.test(token))
    throw new CozeniError("invalid_input");
  return `cozeni_customer=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${origin(siteOrigin).protocol === "https:" ? "; Secure" : ""}`;
}
export function clearCustomerCookie(siteOrigin: string): string {
  return `cozeni_customer=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${origin(siteOrigin).protocol === "https:" ? "; Secure" : ""}`;
}
/**
 * 拒否結果から自動遷移すべきenter_urlを取り出す。許可・unavailable・enter_url無しは
 * undefined。フレームワークに依存しない共通ヘルパーで、Next.js等の実際のredirectは
 * 呼び出し側（サブパスexport等）が行う。
 *
 * `entitlement.enterUrl`は手で組み立てられる可能性があるため、checkEntitlement内部と
 * 同じvalidEnterUrl()で構造（https・userinfo無し・pathname固定・product_id一致・
 * fragment無し）を再検証する。第2引数のproductIdは、この結果を表示・利用する
 * ページ・APIが実際に問い合わせたproductIdを渡すこと（呼び出し側が別の商品IDの
 * enter_urlを誤って採用しないようにするため）。
 */
export function enterRedirectUrl(
  entitlement: Entitlement,
  productId: string,
): URL | undefined {
  if (entitlement.entitled || entitlement.reason === "unavailable")
    return undefined;
  return validEnterUrl(entitlement.enterUrl, productId);
}
/**
 * Web標準Responseでenter_urlへ303遷移する。enter_urlが無い・検証に通らない場合は
 * undefined（呼び出し側でサイト内の拒否表示にフォールバックする）。
 */
export function enterRedirectResponse(
  entitlement: Entitlement,
  productId: string,
): Response | undefined {
  const target = enterRedirectUrl(entitlement, productId);
  if (!target) return undefined;
  return new Response(null, {
    status: 303,
    headers: {
      Location: target.href,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
