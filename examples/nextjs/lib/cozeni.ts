import "server-only";
import { createCustomerClient, trustedSiteUrl } from "@nulogic/cozeni-sdk";
import {
  AccessDenied,
  denialResponse,
  denialStatus,
  type Entitlement,
  nextEntitlement,
  type RequireEntitlementOptions,
  requireEntitlement as redirectingRequireEntitlement,
} from "@nulogic/cozeni-sdk/next";

class ServerConfigurationError extends Error {
  constructor(readonly settingName: string) {
    super("サーバー設定を確認してください。");
  }
}
// 値・例外本文・Cookie・コードはログへ渡さない。
export function reportServerError(error: unknown, operation: string) {
  if (error instanceof ServerConfigurationError) {
    console.error("[cozeni] サーバー設定エラー", {
      operation,
      setting: error.settingName,
    });
  } else if (!(error instanceof AccessDenied)) {
    console.error("[cozeni] サーバー処理エラー", { operation });
  }
}
export function setting(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new ServerConfigurationError(name);
  return value;
}
// denialResponse()のenter_url再検証（productId一致）に使う。未設定・不正時は
// 空文字を返し、一致しないため安全にenter_urlが省略される
// （この場合はもともとCOZENI_PRODUCT_ID不備でunavailable拒否になっている）。
export function productId(): string {
  try {
    return setting("COZENI_PRODUCT_ID");
  } catch {
    return "";
  }
}
export function siteUrl(path: string) {
  try {
    return trustedSiteUrl(setting("COZENI_SITE_ORIGIN"), path);
  } catch {
    throw new ServerConfigurationError("COZENI_SITE_ORIGIN");
  }
}
// ハンドオフのコード交換専用。認可の接続先検証とは別に、単独でも使う。
export function customerClient() {
  try {
    return createCustomerClient({
      apiOrigin: setting("COZENI_API_ORIGIN"),
      timeoutMs: 3000,
    });
  } catch {
    throw new ServerConfigurationError("COZENI_API_ORIGIN");
  }
}
// 接続設定を検証し、認可問い合わせ用の非秘密値を返す。customerClient()を検証だけに
// 流用し、生成したclientは破棄する（実際の呼び出しはSDK側が改めて構築する）。
function validatedConnection(): {
  apiOrigin: string;
  productId: string;
  timeoutMs: number;
} {
  customerClient();
  return {
    apiOrigin: setting("COZENI_API_ORIGIN"),
    productId: setting("COZENI_PRODUCT_ID"),
    timeoutMs: 3000,
  };
}
export async function entitlement(): Promise<Entitlement> {
  try {
    return await nextEntitlement(validatedConnection());
  } catch (error) {
    reportServerError(error, "購入者認可");
    return { entitled: false, reason: "unavailable" };
  }
}
export { AccessDenied, denialResponse, denialStatus };
/**
 * pageの入口専用。権利がなければenter_urlへ自動でリダイレクトし、それが
 * できない場合はAccessDeniedを投げる。redirect()はNext.jsの制御フロー例外を
 * 投げるため、この関数の呼び出しを広いtry/catchで包まない
 * （AccessDeniedだけを捕捉する）。Server ActionとRoute Handlerではこの関数を
 * 使わない。Route Handlerは entitlement() + denialResponse()（Web Response）、
 * Server Actionは entitlement() の結果をplain objectとして返す形を使う。
 */
export async function requireEntitlement(haltRedirect = false): Promise<void> {
  let options: RequireEntitlementOptions;
  try {
    options = { ...validatedConnection(), haltRedirect };
  } catch (error) {
    reportServerError(error, "購入者認可");
    throw new AccessDenied({ entitled: false, reason: "unavailable" });
  }
  await redirectingRequireEntitlement(options);
}
// 関連ページから直接呼ばれても、データ取得直前に独立して認可する。redirectはしない。
export async function protectedData() {
  const result = await entitlement();
  if (!result.entitled) throw new AccessDenied(result);
  return { content: setting("COZENI_PROTECTED_CONTENT") };
}
