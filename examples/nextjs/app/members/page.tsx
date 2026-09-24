import { redirect } from "next/navigation";
import {
  AccessDenied,
  protectedData,
  reportServerError,
  requireEntitlement,
  siteUrl,
} from "../../lib/cozeni";
import { submitProtectedAction } from "./actions";
export const dynamic = "force-dynamic";
export const revalidate = 0;
function Denied({ reason }: { reason: string }) {
  return (
    <main>
      <h1>コンテンツを表示できません</h1>
      <p>
        {reason === "unavailable"
          ? "権限を確認できません。時間をおいて再試行してください。"
          : reason === "revoked"
            ? "この商品の利用権限は無効になっています。"
            : reason === "no_grant"
              ? "この商品の購入権限がありません。"
              : "購入時のメールアドレスで再入場してください。"}
      </p>
      <p>
        <a href="/members">再試行</a>
      </p>
      <form action="/cozeni/clear" method="post">
        <button type="submit">購入者Cookieを消去</button>
      </form>
    </main>
  );
}
export default async function Members({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  // 重複クエリ（string[]）はJavaScript例（web-handler.mjs）と同じ扱いで、
  // 単一の非空文字列でなければ無効なコードとして扱う。
  const codeValue = query.cozeni_code;
  if (codeValue !== undefined) {
    const valid = typeof codeValue === "string" && codeValue.length > 0;
    let target: URL;
    try {
      target = siteUrl(valid ? "/cozeni/handoff" : "/members");
    } catch (error) {
      reportServerError(error, "購入者ページのコード転送");
      return <Denied reason="unavailable" />;
    }
    if (valid) target.searchParams.set("cozeni_code", codeValue);
    else target.searchParams.set("cozeni_error", "invalid_code");
    redirect(target.href);
  }
  // ハンドオフ直後（cozeni_codeを処理した直後のハンドオフ成功で付く
  // cozeni_handoff、または交換失敗で付くcozeni_error）は、重複クエリで
  // string[]になっていても「印がある」とみなし、enter_urlがあっても
  // 再リダイレクトせずここで留める（無限リダイレクトの回避）。
  const haltRedirect =
    query.cozeni_error !== undefined || query.cozeni_handoff !== undefined;
  const cozeniError =
    typeof query.cozeni_error === "string" ? query.cozeni_error : undefined;
  try {
    await requireEntitlement(haltRedirect);
  } catch (error) {
    // requireEntitlement()はenter_urlがあればredirect()の制御フロー例外を投げる。
    // AccessDenied以外はここで握りつぶさず、そのまま上位へ伝播させる。
    if (!(error instanceof AccessDenied)) throw error;
    reportServerError(error, "購入者ページ");
    const reason =
      error.reason === "no_session" && cozeniError === "unavailable"
        ? "unavailable"
        : error.reason;
    return <Denied reason={reason} />;
  }
  // ここに到達したら権利がある。ハンドオフ成功直後・交換失敗の印が付いていれば、
  // 両方を外したクリーンなURLへ正規化する（アドレスバーに残さない）。
  if (haltRedirect) {
    let target: URL | undefined;
    try {
      target = siteUrl("/members");
    } catch (error) {
      reportServerError(error, "購入者ページの正規化");
    }
    if (target) redirect(target.href);
  }
  // pageの認可後に権利が失効しても、データ層でもう一度拒否する（redirectはしない）。
  try {
    const data = await protectedData();
    return (
      <main>
        <h1>購入者限定ページ</h1>
        <p data-testid="protected-content">{data.content}</p>
        <form action={submitProtectedAction}>
          <button type="submit">保護された操作を実行</button>
        </form>
        <form action="/cozeni/clear" method="post">
          <button type="submit">購入者Cookieを消去</button>
        </form>
      </main>
    );
  } catch (error) {
    reportServerError(error, "購入者ページ");
    return (
      <Denied
        reason={error instanceof AccessDenied ? error.reason : "unavailable"}
      />
    );
  }
}
