// Next.js App Router専用のサブパスexport（@nulogic/cozeni-sdk/next）。Next.js 15・16に対応する。
// ハンドオフ（cozeni_codeの交換とコード除去）をproxy / middlewareで、購入者の認可と
// enter_urlへの自動リダイレクト、無限リダイレクトの停止条件をpageの入口で行う。
// 共通SDK本体（./index.ts）はフレームワーク非依存のまま維持し、
// Next.js固有の処理（cookies() / redirect() / NextResponse）はここに閉じ込める。
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import {
  type ClientOptions,
  CozeniError,
  createCustomerClient,
  customerCookie,
  type Entitlement,
  enterRedirectUrl,
  trustedSiteUrl,
} from "./index.js";

// このモジュールはNext.jsのバンドラ（webpack/turbopack）を通してのみ動作する。
// "next/headers" / "next/navigation" はNext.js本体がpackage.jsonにexportsを
// 持たないため、素のNode ESM importでは解決できない（README参照）。

export type { Entitlement } from "./index.js";
export { CozeniError, enterRedirectUrl } from "./index.js";

// 許可以外（拒否・unavailable）のEntitlement。
export type EntitlementDenied = Exclude<Entitlement, { entitled: true }>;

export interface NextEntitlementOptions
  extends Pick<ClientOptions, "fetch" | "timeoutMs"> {
  apiOrigin: string;
  productId: string;
}

/**
 * cookies()から`cozeni_customer`だけを取り出し、購入者の権利をCozeniへ問い合わせる。
 * Cookie無しでも呼び出せる（未認証がこのAPIの主要な入口のため）。
 * 想定外の例外（設定不備・通信障害）は内部で吸収し、unavailableとして返す。
 */
export async function nextEntitlement(
  options: NextEntitlementOptions,
): Promise<Entitlement> {
  try {
    const store = await cookies();
    const token = store.get("cozeni_customer")?.value;
    const client = createCustomerClient({
      apiOrigin: options.apiOrigin,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    });
    return await client.checkEntitlement({
      productId: options.productId,
      cookieHeader: token ? `cozeni_customer=${token}` : undefined,
    });
  } catch {
    return { entitled: false, reason: "unavailable" };
  }
}

/**
 * 拒否理由（enter_urlを含む）を保持する例外。redirectへ進めない場合に
 * 呼び出し側がサイト内の拒否表示を出すために使う。
 */
export class AccessDenied extends Error {
  constructor(readonly entitlement: EntitlementDenied) {
    super("購入者権限を確認できませんでした。");
    this.name = "AccessDenied";
  }
  get reason(): EntitlementDenied["reason"] {
    return this.entitlement.reason;
  }
}

/** 本番のAPIオリジン。開発時だけCOZENI_API_ORIGINで上書きする。 */
export const DEFAULT_API_ORIGIN = "https://api.cozeni.net";
const HANDOFF_COOKIE = "cozeni_handoff";
const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};

function apiOrigin(): string {
  return process.env.COZENI_API_ORIGIN?.trim() || DEFAULT_API_ORIGIN;
}

/** 受信したCookieヘッダーから、指定した名前の値を1つだけ取り出す。 */
function cookieValue(header: string | null, name: string): string | undefined {
  const values =
    header
      ?.split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${name}=`))
      .map((part) => part.slice(name.length + 1)) ?? [];
  return values.length > 0 ? (values[0] ?? "") : undefined;
}

/**
 * ハンドオフの結果を次の1リクエストだけに伝える印。値は3種の固定文字列だけで、秘密を含まない。
 * proxyが次のリクエストを通さない設定でも、60秒で消える。
 */
type HandoffMark = "ok" | "invalid_code" | "unavailable";
function markCookie(value: HandoffMark | "", secure: boolean): string {
  return `${HANDOFF_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? 60 : 0}${secure ? "; Secure" : ""}`;
}

export interface HandoffOptions
  extends Pick<ClientOptions, "fetch" | "timeoutMs"> {
  /** 既定はCOZENI_API_ORIGIN、無ければ本番。 */
  apiOrigin?: string;
  /** 既定はCOZENI_SITE_ORIGIN。戻り先はこのオリジンに固定し、Hostヘッダーを信用しない。 */
  siteOrigin?: string;
}

/** 印の消去にSecureを付けるか。設定が不正でも印は消すため、受信URLで代用する。 */
function secureSite(request: Request): boolean {
  try {
    const configured = process.env.COZENI_SITE_ORIGIN;
    if (configured)
      return trustedSiteUrl(configured, "/").protocol === "https:";
  } catch {
    // 下の受信URLの判定に落とす。
  }
  return new URL(request.url).protocol === "https:";
}

/**
 * ハンドオフ直後の印があれば、応答で印を消す（Set-Cookieを足した応答を返す）。
 * 印が無ければ同じ応答をそのまま返す。
 *
 * `response.cookies` ではなくヘッダーで消すこと。Next.jsはmiddlewareのCookie操作を
 * 同じリクエストにも反映するため、ページから印が見えなくなり停止条件が効かない。
 */
export function clearCozeniHandoff(
  request: Request,
  response: Response,
): Response {
  if (cookieValue(request.headers.get("cookie"), HANDOFF_COOKIE) === undefined)
    return response;
  const clear = markCookie("", secureSite(request));
  try {
    response.headers.append("Set-Cookie", clear);
    return response;
  } catch {
    // Response.redirect()等はヘッダーを変更できないため、複製してから足す。
    const copy = new Response(response.body, response);
    copy.headers.append("Set-Cookie", clear);
    return copy;
  }
}

/**
 * `?cozeni_code` 付きのGETを処理する。既存のmiddleware / proxyと組み合わせる用。
 *
 * コードを交換して `cozeni_customer` を設定し、コードを除いた同じURL（自サイトのオリジン）へ
 * 303で戻す。結果は1回だけ有効な `cozeni_handoff` の印（ok / invalid_code / unavailable）で
 * 伝える。`cozeni_code` が無いリクエストではundefinedを返す（既存の処理をそのまま続ける）。
 * 戻り値があれば、middleware / proxyはそれをそのまま返すこと。
 *
 * 次のリクエストで印を消すのは `clearCozeniHandoff()` の役割。
 */
export async function handleCozeniHandoff(
  request: Request,
  options: HandoffOptions = {},
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const codes = url.searchParams.getAll("cozeni_code");
  if (codes.length === 0 || request.method !== "GET") return undefined;
  const configuredSite = options.siteOrigin ?? process.env.COZENI_SITE_ORIGIN;

  let target: URL;
  try {
    // オリジンは設定値に固定し、受信URLからはパスとクエリだけを移す
    // （"//other.example" のようなパスでも別オリジンにならない）。
    target = trustedSiteUrl(configuredSite ?? "", "/");
    target.pathname = url.pathname;
    const search = new URLSearchParams(url.search);
    search.delete("cozeni_code");
    target.search = search.size > 0 ? `?${search}` : "";
  } catch {
    // 戻り先を安全に決められないので、コードを交換しない（ログに値を残さない）。
    console.error("[cozeni] COZENI_SITE_ORIGIN を確認してください。");
    return new Response(
      "接続設定を確認できません。サイト運営者へお問い合わせください。",
      { status: 503, headers: privateHeaders },
    );
  }
  const secure = target.protocol === "https:";
  const headers = new Headers({ ...privateHeaders, Location: target.href });
  let mark: HandoffMark;
  const code = codes[0];
  if (codes.length !== 1 || !code) mark = "invalid_code";
  else {
    try {
      const { token } = await createCustomerClient({
        apiOrigin: options.apiOrigin ?? apiOrigin(),
        fetch: options.fetch,
        timeoutMs: options.timeoutMs ?? 5000,
      }).exchangeHandoff(code);
      headers.append("Set-Cookie", customerCookie(token, target.origin));
      mark = "ok";
    } catch (error) {
      // 交換失敗では既存の購入者Cookieを変えない。コードや例外の本文は残さない。
      mark =
        error instanceof CozeniError &&
        (error.code === "invalid_code" || error.code === "invalid_input")
          ? "invalid_code"
          : "unavailable";
    }
  }
  headers.append("Set-Cookie", markCookie(mark, secure));
  return new Response(null, { status: 303, headers });
}

/**
 * Next.js 16の `proxy.ts`（15以前は `middleware.ts`）からそのまま export する。
 *
 * ```ts
 * export { cozeniProxy as proxy } from "@nulogic/cozeni-sdk/next";
 * ```
 *
 * `cozeni_code` 付きのGETは `handleCozeniHandoff()` で処理し、印が付いた次のリクエストは
 * ページへ通したうえで応答で印を消す。それ以外は何もしない。
 *
 * Next.jsは第2引数にイベントを渡すため、この関数は設定を受け取らない。
 * 既存のmiddlewareがある場合は、`handleCozeniHandoff()` と `clearCozeniHandoff()` を
 * 既存の処理に組み込む（この関数に置き換えると、既存の処理が動かなくなる）。
 */
export async function cozeniProxy(
  request: Request,
): Promise<Response | undefined> {
  const handoff = await handleCozeniHandoff(request);
  if (handoff) return handoff;
  if (cookieValue(request.headers.get("cookie"), HANDOFF_COOKIE) === undefined)
    return undefined;
  return clearCozeniHandoff(request, NextResponse.next());
}

/**
 * Route Handler・Server Action用。リダイレクトせずに権利の判定結果を返す。
 * 接続先はCOZENI_API_ORIGIN、無ければ本番。
 */
export function entitlement(
  productId: string,
  options: Pick<ClientOptions, "fetch" | "timeoutMs"> = {},
): Promise<Entitlement> {
  return nextEntitlement({ ...options, apiOrigin: apiOrigin(), productId });
}

export interface RequireEntitlementOptions extends NextEntitlementOptions {
  /**
   * ハンドオフのコード交換直後（`cozeni_code`を処理した直後のリクエスト、または
   * 交換失敗で`cozeni_error`が付いたリクエスト）であればtrueを渡す。無限リダイレクトを
   * 避けるため、この状態で拒否された場合はenter_urlがあっても再リダイレクトせず、
   * AccessDeniedを投げてサイト内の拒否表示に留める。
   */
  haltRedirect?: boolean;
}

/**
 * pageの入口専用。redirectするのはこの関数だけで、Server Action・Route Handlerでは
 * 使わない（`entitlement()` + `denialResponse()`、またはplain objectを返す形を使う）。
 *
 * `requireEntitlement(productId)`: 権利があれば何もしない。無ければenter_urlへredirect()する。
 * ハンドオフ直後の印（`cozeni_handoff`）があればredirectせずAccessDeniedを投げる
 * （無限リダイレクトの回避）。印が`unavailable`なら、交換障害を再入場の要求に変えないよう
 * 理由をunavailableにする。enter_urlが無い・判定不能のときもAccessDeniedを投げる。
 *
 * `requireEntitlement(options)`: 以前の版の呼び出し方。停止条件は`haltRedirect`で渡す。
 *
 * redirect()の例外はcatchで握りつぶさないこと。広いtry/catchで包むと
 * Next.jsのリダイレクトが機能しない（AccessDeniedだけを捕捉する）。
 */
export async function requireEntitlement(
  productId: string,
  options?: Pick<ClientOptions, "fetch" | "timeoutMs">,
): Promise<void>;
export async function requireEntitlement(
  options: RequireEntitlementOptions,
): Promise<void>;
export async function requireEntitlement(
  input: string | RequireEntitlementOptions,
  settings: Pick<ClientOptions, "fetch" | "timeoutMs"> = {},
): Promise<void> {
  if (typeof input !== "string") {
    const result = await nextEntitlement(input);
    if (result.entitled) return;
    if (!input.haltRedirect) {
      const target = enterRedirectUrl(result, input.productId);
      if (target) redirect(target.href);
    }
    throw new AccessDenied(result);
  }
  const result = await entitlement(input, settings);
  if (result.entitled) return;
  let mark: string | undefined;
  try {
    mark = (await cookies()).get(HANDOFF_COOKIE)?.value;
  } catch {
    // Cookieを読めない場合は印なしとして扱う（権利の判定自体は済んでいる）。
  }
  if (mark !== undefined) {
    throw new AccessDenied(
      mark === "unavailable"
        ? { entitled: false, reason: "unavailable" }
        : result,
    );
  }
  const target = enterRedirectUrl(result, input);
  if (target) redirect(target.href);
  throw new AccessDenied(result);
}

/** unavailable=503、no_session=401、それ以外(no_grant/revoked)=403。 */
export function denialStatus(reason: EntitlementDenied["reason"]): number {
  return reason === "unavailable" ? 503 : reason === "no_session" ? 401 : 403;
}

/**
 * Route Handler（JSON API）専用。この関数自体はredirect()を呼ばない。
 * enter_urlをJSON本文へ含めた拒否Responseを返すだけなので、fetchの呼び出し元を
 * HTMLへ飛ばさない。redirectするのはpage専用のrequireEntitlement()だけで、
 * Route Handlerではこちらと`nextEntitlement()`を組み合わせて使う。
 *
 * Server Actionはこの関数を使わない。Web Responseを返すべきではなく、呼び出し元
 * （クライアントコンポーネント）へ渡す通常の戻り値（plain object）で拒否理由を
 * 表現する。`nextEntitlement()`の結果や`AccessDenied.reason`をそのまま返すこと。
 *
 * `entitlement.enterUrl`は呼び出し元が手で組み立てた値の可能性があるため、
 * enterRedirectUrl()と同じ構造検証（productId一致を含む）を再度通してからJSONへ
 * 書き出す。第2引数には実際に問い合わせたproductIdを渡すこと。
 */
export function denialResponse(
  entitlement: EntitlementDenied,
  productId: string,
): Response {
  const body: { error: EntitlementDenied["reason"]; enter_url?: string } = {
    error: entitlement.reason,
  };
  const target = enterRedirectUrl(entitlement, productId);
  if (target) body.enter_url = target.href;
  return Response.json(body, {
    status: denialStatus(entitlement.reason),
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
