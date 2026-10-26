import {
  type ClientOptions,
  CozeniError,
  failure,
  isLoopback,
  knownCheckoutOrigin,
  type ManagementClientOptions,
  origin,
  record,
  resolveApiOrigin,
  transport,
} from "./transport.js";

export type {
  ClientOptions,
  Environment,
  ManagementClientOptions,
} from "./transport.js";
export { CozeniError } from "./transport.js";

export type Scope =
  | "products:read"
  | "products:write"
  | "checkout_links:read"
  | "checkout_links:write"
  | "customers:read"
  | "checkouts:write";
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
// 機能フラグの設定値。件数・キー・値の制約はAPI側で検証する。秘匿情報は入れない。
export type FeatureFlagMetadata = Record<string, string | number | boolean>;
// 商品の種類。作成できるのは page と feature で、file は応答にだけ現れる。
export type AccessType = "page" | "feature" | "file";
// 作成の入力は access_type で2形に分かれる（API契約のoneOfと同じ）。
export type CreateProduct =
  | {
      name: string;
      price_jpy: number;
      access_type?: "page";
      access_url: string;
      // 型で混ぜ書きを止める（API側も400）。
      metadata?: never;
      // Markdown。前後の空白を除いて4000コードポイントまで。null・空白だけなら説明なし。
      // 長さはSDKでは検証せず、サーバーの判定（invalid_input）に任せる。
      description?: string | null;
    }
  | {
      name: string;
      price_jpy: number;
      access_type: "feature";
      metadata?: FeatureFlagMetadata;
      access_url?: never;
      description?: string | null;
    };
// Partial<CreateProduct> はunionのPartialになりAPIが受け付ける形と違うので明示する。
// access_type は作成後に変えられないので送れない。
export interface UpdateProduct {
  name?: string;
  price_jpy?: number;
  access_url?: string;
  metadata?: FeatureFlagMetadata;
  description?: string | null;
}
export interface ProductImage {
  id: string;
  url: string;
  content_type: string;
  size_bytes: number;
}
// unionのCreateProductはextendsできないので、応答の形を別に持つ。
// URLを持たない商品（feature・file）の access_url は null。判定には access_type を使う。
export interface Product {
  id: string;
  name: string;
  price_jpy: number;
  currency: "jpy";
  access_type: AccessType;
  access_url: string | null;
  metadata: FeatureFlagMetadata;
  description: string | null;
  images: ProductImage[];
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
export interface CustomerState {
  // 機能フラグの権利が1件以上あるときだけ返る。無ければ null。
  customerId: string | null;
  featureFlags: {
    productId: string;
    benefitId: string;
    grantedAt: string;
    metadata: FeatureFlagMetadata;
  }[];
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
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url))) ||
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
// クリエイターID（`cre_` で始まる）の形式。URLのパスに入れるため、記号を含めない。
const CREATOR_ID = /^cre_[A-Za-z0-9]{1,128}$/;
const PORTAL_PATH = /^\/portal\/(cre_[A-Za-z0-9]{1,128})$/;
const PORTAL_CODE = /^[A-Za-z0-9_-]{1,256}$/;
/**
 * 購入者ポータルのURL（`/portal/{クリエイターID}?cozeni_portal_code=…`）の構造検証。
 * enter_urlと同じく、API応答をそのまま遷移先にせず構造で縛る。
 *
 * - httpsが必須。httpはloopbackだけ許可（開発用）
 * - userinfo・fragmentを含まない
 * - pathnameは"/portal/{クリエイターID}"。creatorIdを渡したらその値と一致する
 * - クエリは"cozeni_portal_code"の1個だけで、値は空でない英数字・"_"・"-"
 * - 既知の環境（本番・サンドボックス）につないでいれば、その環境の購入者面のオリジンと一致する
 *
 * いずれかに反する場合はundefined（採用しない）。
 */
function validPortalUrl(
  value: unknown,
  expected: { origin?: string; creatorId?: string },
): URL | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const creator = PORTAL_PATH.exec(url.pathname)?.[1];
  const code = url.searchParams.get("cozeni_portal_code");
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url))) ||
    url.username ||
    url.password ||
    url.hash ||
    !creator ||
    (expected.creatorId !== undefined && creator !== expected.creatorId) ||
    (expected.origin !== undefined && url.origin !== expected.origin) ||
    [...url.searchParams.keys()].length !== 1 ||
    !code ||
    !PORTAL_CODE.test(code)
  )
    return undefined;
  return url;
}
const CHECKOUT_PATH = /^\/checkout\/[A-Za-z0-9_-]{1,200}$/;
/**
 * 購入画面のURL（`/checkout/{識別子}?checkout={checkout_id}`）の構造検証。
 * validPortalUrlと同じく、API応答をそのまま購入者へ渡さず構造で縛る。
 *
 * - httpsが必須。httpはloopbackだけ許可（開発用）
 * - userinfo・fragmentを含まない
 * - pathnameは"/checkout/{識別子}"（英数字・"_"・"-"、200文字まで）
 * - クエリは"checkout"の1個だけで、値は応答のcheckout_idと完全一致する
 * - 既知の環境（本番・サンドボックス）につないでいれば、その環境の購入者面のオリジンと一致する
 *
 * いずれかに反する場合はundefined（採用しない）。
 */
function validCheckoutUrl(
  value: unknown,
  expected: { origin?: string; checkoutId: string },
): URL | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url))) ||
    url.username ||
    url.password ||
    url.hash ||
    !CHECKOUT_PATH.test(url.pathname) ||
    (expected.origin !== undefined && url.origin !== expected.origin) ||
    [...url.searchParams.keys()].length !== 1 ||
    url.searchParams.get("checkout") !== expected.checkoutId
  )
    return undefined;
  return url;
}
function identifier(id: string): string {
  if (!id || id.length > 200 || id === "." || id === "..")
    throw new CozeniError("invalid_input");
  return encodeURIComponent(id);
}
function emailInput(email: string): string {
  // 形式の検査はAPI側で行う。明らかな誤りだけ送信前に止める。
  if (typeof email !== "string" || !email.trim() || email.length > 254)
    throw new CozeniError("invalid_input");
  return email;
}
function metadataValue(value: unknown): FeatureFlagMetadata | undefined {
  if (!record(value)) return;
  for (const item of Object.values(value))
    if (
      typeof item !== "string" &&
      typeof item !== "boolean" &&
      !(typeof item === "number" && Number.isFinite(item))
    )
      return;
  return value as FeatureFlagMetadata;
}
function customerState(data: unknown, status: number): CustomerState {
  if (
    !record(data) ||
    (data.customer_id !== null && typeof data.customer_id !== "string") ||
    !Array.isArray(data.feature_flags)
  )
    throw new CozeniError("invalid_response", status);
  const featureFlags = data.feature_flags.map((flag: unknown) => {
    const metadata = record(flag) ? metadataValue(flag.metadata) : undefined;
    if (
      !record(flag) ||
      typeof flag.product_id !== "string" ||
      typeof flag.benefit_id !== "string" ||
      typeof flag.granted_at !== "string" ||
      !metadata
    )
      throw new CozeniError("invalid_response", status);
    return {
      productId: flag.product_id,
      benefitId: flag.benefit_id,
      grantedAt: flag.granted_at,
      metadata,
    };
  });
  return { customerId: data.customer_id, featureFlags };
}
export function createManagementClient(options: ManagementClientOptions) {
  if (!options.apiKey || /\s/.test(options.apiKey))
    throw new CozeniError("invalid_input");
  const send = transport(options, options.apiKey);
  // 購入画面のURLを照合する購入者面のオリジン（既知の環境のときだけ）。
  const checkoutOrigin = knownCheckoutOrigin(resolveApiOrigin(options));
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
  async function getCustomerState(input: {
    email: string;
  }): Promise<CustomerState> {
    const email = emailInput(input?.email);
    // メールアドレスはURLに載せない（アクセスログに残さない）ので本文で送る。
    const { response, data } = await send("/customers/state", "POST", {
      email,
    });
    if (!response.ok) throw failure(response, data);
    if (response.status !== 200)
      throw new CozeniError("invalid_response", response.status);
    return customerState(data, response.status);
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
      // 画像を1枚設定する（既存の画像は差し替わり、URLが変わる）。形式（JPEG・PNG・WebP）と
      // 大きさ（5MB）はサーバーが判定するため、SDKでは検証しない（image_too_large /
      // unsupported_image_typeをそのまま返す）。
      putImage: async (productId: string, file: Blob) => {
        const path = `/products/${identifier(productId)}/image`;
        if (!(file instanceof Blob)) throw new CozeniError("invalid_input");
        const form = new FormData();
        form.append("file", file);
        return request<Product>(path, "PUT", form);
      },
      // 画像が無くても200で商品を返す。
      deleteImage: async (productId: string) =>
        request<Product>(`/products/${identifier(productId)}/image`, "DELETE"),
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
    // ログイン中のユーザーのメールアドレスを固定した購入画面を作る。
    // URLは購入者本人にだけ渡す。有効期限は30分で、過ぎたら作り直す。
    async createCheckout(input: {
      productId: string;
      email: string;
    }): Promise<{ checkoutId: string; url: string; expiresAt: string }> {
      if (
        typeof input?.productId !== "string" ||
        !input.productId ||
        input.productId.length > 200
      )
        throw new CozeniError("invalid_input");
      const email = emailInput(input.email);
      const { response, data } = await send("/checkout/sessions", "POST", {
        product_id: input.productId,
        email,
      });
      if (!response.ok) throw failure(response, data);
      if (
        response.status !== 201 ||
        !record(data) ||
        typeof data.checkout_id !== "string" ||
        typeof data.expires_at !== "string"
      )
        throw new CozeniError("invalid_response", response.status);
      const url = validCheckoutUrl(data.url, {
        origin: checkoutOrigin,
        checkoutId: data.checkout_id,
      });
      if (!url) throw new CozeniError("invalid_response", response.status);
      return {
        checkoutId: data.checkout_id,
        url: url.href,
        expiresAt: data.expires_at,
      };
    },
    getCustomerState,
    // 購入者がその商品の機能フラグを持つか。無ければ { granted: false, metadata: {} }。
    // 照会の失敗（認証・レート制限・通信など）は握りつぶさず投げる。
    async hasFeatureFlag(input: {
      email: string;
      productId: string;
    }): Promise<{ granted: boolean; metadata: FeatureFlagMetadata }> {
      const state = await getCustomerState({ email: input?.email });
      const flag = state.featureFlags.find(
        (item) => item.productId === input.productId,
      );
      return flag
        ? { granted: true, metadata: flag.metadata }
        : { granted: false, metadata: {} };
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
  // 購入者ポータルのURLを照合する購入者面のオリジン（既知の環境のときだけ）。
  const checkoutOrigin = knownCheckoutOrigin(resolveApiOrigin(options));
  return {
    /**
     * 購入者ポータル（Cozeniの `/portal/{クリエイターID}`）を確認コードの入力なしで開く
     * URLを発行する。URLのコードは60秒・1回限りなので、購入者がボタンを押したときに
     * サーバーで呼び、返ったURLへそのままリダイレクトする（ページの描画時に発行しない）。
     * URLとコードはログ・解析・エラー・キャッシュに残さない。
     *
     * 失敗はCozeniErrorで投げる。`no_session`（購入者Cookieが無い・不正。APIを呼ばない。
     * またはAPIの401）、`unavailable`（503）、`network_error` / `timeout`、
     * `invalid_response`（URLが構造検証に通らない）など。
     */
    async createPortalLink(
      input: { cookieHeader?: string; creatorId?: string } = {},
    ): Promise<{ url: string }> {
      if (input.creatorId !== undefined && !CREATOR_ID.test(input.creatorId))
        throw new CozeniError("invalid_input");
      // 認証が必須のAPIなので、Cookieが無ければ呼ばない（結果は必ず401になる）。
      const token = customerToken(input.cookieHeader);
      if (!token) throw new CozeniError("no_session");
      const { response, data } = await send(
        "/customer/portal-link",
        "POST",
        undefined,
        { Cookie: `cozeni_customer=${token}` },
      );
      if (response.status !== 200) {
        const error = failure(response, data);
        // no_sessionは401との組でだけ認める（契約外の状態を未入場として扱わない）。
        if (error.code === "no_session" && response.status !== 401)
          throw new CozeniError("invalid_response", response.status);
        throw error;
      }
      const url = record(data)
        ? validPortalUrl(data.url, {
            origin: checkoutOrigin,
            creatorId: input.creatorId,
          })
        : undefined;
      if (!url) throw new CozeniError("invalid_response", response.status);
      return { url: url.href };
    },
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
