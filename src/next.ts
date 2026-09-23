// Next.js App Router専用のサブパスexport（@nulogic/cozeni-sdk/next）。
// 購入者の認可が拒否されたとき、APIが返すenter_urlへの自動リダイレクトまでこの
// モジュールが行う。共通SDK本体（./index.ts）はフレームワーク非依存のまま維持し、
// Next.js固有の処理（cookies() / redirect()）はここに閉じ込める。
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  type ClientOptions,
  createCustomerClient,
  type Entitlement,
  enterRedirectUrl,
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
 * 使わない（それらはredirectしないnextEntitlement() + denialResponse()を使う）。
 * 権利があれば何もしない。権利が無くenter_urlが使え、停止条件（haltRedirect）にも
 * 当たらなければ、next/navigationのredirect()でenter_urlへ遷移する（制御フロー
 * 例外を投げる）。それ以外（unavailable・enter_url無し・停止条件該当）は
 * AccessDeniedを投げるので、呼び出し側でサイト内の拒否表示に落とす。
 *
 * redirect()の例外はcatchで握りつぶさないこと。広いtry/catchで包むと
 * Next.jsのリダイレクトが機能しない。
 */
export async function requireEntitlement(
  options: RequireEntitlementOptions,
): Promise<void> {
  const result = await nextEntitlement(options);
  if (result.entitled) return;
  if (!options.haltRedirect) {
    const target = enterRedirectUrl(result, options.productId);
    if (target) redirect(target.href);
  }
  throw new AccessDenied(result);
}

/** unavailable=503、no_session=401、それ以外(no_grant/revoked)=403。 */
export function denialStatus(reason: EntitlementDenied["reason"]): number {
  return reason === "unavailable" ? 503 : reason === "no_session" ? 401 : 403;
}

/**
 * Route Handler（JSON API）・Server Action向け。この関数自体はredirect()を
 * 呼ばない。enter_urlをJSON本文へ含めた拒否Responseを返すだけなので、fetchの
 * 呼び出し元をHTMLへ飛ばさない。redirectするのはpage専用のrequireEntitlement()
 * だけで、それ以外の入口はこちらとnextEntitlement()を組み合わせて使う。
 */
export function denialResponse(entitlement: EntitlementDenied): Response {
  const body: { error: EntitlementDenied["reason"]; enter_url?: string } = {
    error: entitlement.reason,
  };
  // enterUrlはnextEntitlement()が返す値（checkEntitlement内でvalidEnterUrl()による
  // 構造検証を通過済み）をそのまま転記する。redirect()やLocationへは使わない
  // （このJSON本文を実際にredirectへ使うかどうかはfetchの呼び出し元の責任）。
  if (entitlement.reason !== "unavailable" && entitlement.enterUrl)
    body.enter_url = entitlement.enterUrl;
  return Response.json(body, {
    status: denialStatus(entitlement.reason),
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
