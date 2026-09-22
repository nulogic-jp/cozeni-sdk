import { CozeniError, customerCookie } from "@nulogic/cozeni-sdk";
import {
  customerClient,
  reportServerError,
  siteUrl,
} from "../../../lib/cozeni";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  });
  let target: URL;
  try {
    target = siteUrl("/members");
  } catch (error) {
    reportServerError(error, "購入者コード交換");
    return new Response(
      "接続設定を確認できません。サイト運営者へお問い合わせください。",
      {
        status: 503,
        headers,
      },
    );
  }
  try {
    const codes = new URL(request.url).searchParams.getAll("cozeni_code");
    if (codes.length !== 1 || !codes[0])
      throw new CozeniError("invalid_code", 400);
    const { token } = await customerClient().exchangeHandoff(codes[0]);
    headers.set("Set-Cookie", customerCookie(token, target.origin));
  } catch (error) {
    // 交換失敗は既存Cookieを消去せず、戻り先で改めて認可する。
    // コードや例外の生情報をログ・URLへ残さず、失敗後は自動再交換しない。
    if (!(error instanceof CozeniError && error.code === "invalid_code"))
      reportServerError(error, "購入者コード交換");
    target.searchParams.set(
      "cozeni_error",
      error instanceof CozeniError && error.code === "invalid_code"
        ? "invalid_code"
        : "unavailable",
    );
  }
  headers.set("Location", target.href);
  return new Response(null, { status: 303, headers });
}
