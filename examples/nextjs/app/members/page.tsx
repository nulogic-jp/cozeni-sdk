import { AccessDenied, requireEntitlement } from "@nulogic/cozeni-sdk/next";
import { PROTECTED_CONTENT } from "../../lib/content";
import { PRODUCT_ID } from "../../lib/cozeni";
import { submitProtectedAction } from "./actions";

// 認可結果をリクエストをまたいでキャッシュしない。
export const dynamic = "force-dynamic";

function Denied({ reason }: { reason: AccessDenied["reason"] }) {
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
    </main>
  );
}

export default async function Members() {
  try {
    // 権利が無ければ再入場の画面へリダイレクトする。ハンドオフ直後はリダイレクトせず拒否に留める。
    await requireEntitlement(PRODUCT_ID);
  } catch (error) {
    // redirect()の例外は握りつぶさずに投げ直す。AccessDeniedだけを拒否表示にする。
    if (!(error instanceof AccessDenied)) throw error;
    return <Denied reason={error.reason} />;
  }
  return (
    <main>
      <h1>購入者限定ページ</h1>
      <p data-testid="protected-content">{PROTECTED_CONTENT}</p>
      <form action={submitProtectedAction}>
        <button type="submit">保護された操作を実行</button>
      </form>
    </main>
  );
}
