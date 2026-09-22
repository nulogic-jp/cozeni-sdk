import { clearCustomerCookie } from "@nulogic/cozeni-sdk";
import { reportServerError, siteUrl } from "../../../lib/cozeni";
export async function POST(request: Request) {
  const headers = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  };
  try {
    const target = siteUrl("/members");
    if (request.headers.get("Origin") !== target.origin)
      return new Response("この操作は自サイトから実行してください。", {
        status: 403,
        headers,
      });
    return new Response(null, {
      status: 303,
      headers: {
        ...headers,
        Location: target.href,
        "Set-Cookie": clearCustomerCookie(target.origin),
      },
    });
  } catch (error) {
    reportServerError(error, "購入者Cookie消去");
    return new Response(
      "接続設定を確認できません。サイト運営者へお問い合わせください。",
      {
        status: 503,
        headers,
      },
    );
  }
}
