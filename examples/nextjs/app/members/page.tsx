import { redirect } from "next/navigation";
import {
  AccessDenied,
  entitlement,
  otpUrl,
  protectedData,
  reportServerError,
  siteUrl,
} from "../../lib/cozeni";
import { submitProtectedAction } from "./actions";
export const dynamic = "force-dynamic";
export const revalidate = 0;
function Denied({ reason }: { reason: string }) {
  const reentryUrl = reason === "no_session" ? otpUrl() : undefined;
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
      {reason === "no_session" ? (
        reentryUrl ? (
          <a href={reentryUrl}>メール認証で再入場</a>
        ) : (
          <p>再入場の設定を確認中です。サイト運営者へお問い合わせください。</p>
        )
      ) : null}
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
  if (typeof query.cozeni_code === "string") {
    let callback: URL;
    try {
      callback = siteUrl("/cozeni/handoff");
    } catch (error) {
      reportServerError(error, "購入者ページのコード転送");
      return <Denied reason="unavailable" />;
    }
    callback.searchParams.set("cozeni_code", query.cozeni_code);
    redirect(callback.href);
  }
  // 交換失敗だけで既存セッションを無効扱いせず、必ず現在の権利を確認する。
  const result = await entitlement();
  if (!result.entitled) {
    const reason =
      result.reason === "no_session" && query.cozeni_error === "unavailable"
        ? "unavailable"
        : result.reason;
    return <Denied reason={reason} />;
  }
  // pageの認可後に権利が失効しても、データ層でもう一度拒否する。
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
