import "server-only";
import {
  createCustomerClient,
  type Entitlement,
  trustedSiteUrl,
} from "@nulogic/cozeni-sdk";
import { cookies } from "next/headers";

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
export function siteUrl(path: string) {
  try {
    return trustedSiteUrl(setting("COZENI_SITE_ORIGIN"), path);
  } catch {
    throw new ServerConfigurationError("COZENI_SITE_ORIGIN");
  }
}
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
export async function entitlement(): Promise<Entitlement> {
  try {
    const token = (await cookies()).get("cozeni_customer")?.value;
    return await customerClient().checkEntitlement({
      productId: setting("COZENI_PRODUCT_ID"),
      cookieHeader: token ? `cozeni_customer=${token}` : undefined,
    });
  } catch (error) {
    reportServerError(error, "購入者認可");
    return { entitled: false, reason: "unavailable" };
  }
}
export class AccessDenied extends Error {
  constructor(
    readonly reason: Exclude<Entitlement, { entitled: true }>["reason"],
  ) {
    super("購入者権限を確認できませんでした。");
  }
}
export async function requireEntitlement() {
  const result = await entitlement();
  if (!result.entitled) throw new AccessDenied(result.reason);
}
export function denialStatus(reason: AccessDenied["reason"]) {
  return reason === "unavailable" ? 503 : reason === "no_session" ? 401 : 403;
}
// 関連ページから直接呼ばれても、データ取得直前に独立して認可する。
export async function protectedData() {
  await requireEntitlement();
  return { content: setting("COZENI_PROTECTED_CONTENT") };
}

// 再入場リンク未設定でも未認証ページの安全な案内を継続する。
export function otpUrl(): string | undefined {
  try {
    const url = new URL(setting("COZENI_OTP_URL"));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new ServerConfigurationError("COZENI_OTP_URL");
    return url.href;
  } catch {
    reportServerError(
      new ServerConfigurationError("COZENI_OTP_URL"),
      "再入場リンク",
    );
    return undefined;
  }
}
