# Next.js（App Router）への実装

Next.js 15・16 の App Router に対応する。実行できる完全な例は、配布パッケージ内の [`examples/nextjs`](../../../examples/nextjs) にある。例で既存アプリを上書きせず、対象アプリの `src/` の有無・既存の middleware / proxy・認証に合わせて書く。

## 1. proxy（15以前は middleware）

Cozeni から戻ったときの `cozeni_code` の交換と、無限リダイレクトを止める印の管理を SDK に任せる。

- **Next.js 16**：プロジェクト直下（`src/` があればその中）に `proxy.ts` を作る。

  ```ts
  export { cozeniProxy as proxy } from "@nulogic/cozeni-sdk/next";

  export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
  };
  ```

- **Next.js 15**：同じ場所の `middleware.ts` に `export { cozeniProxy as middleware } from "@nulogic/cozeni-sdk/next";` と書く（`config` は同じ）。
- `matcher` には、商品の `access_url`（購入後に表示するページ）を必ず含める。
- **既存の middleware / proxy がある場合**は置き換えない。既存の関数の先頭と最後に次を組み込む。

  ```ts
  import { clearCozeniHandoff, handleCozeniHandoff } from "@nulogic/cozeni-sdk/next";

  export async function proxy(request: NextRequest) {
    const handoff = await handleCozeniHandoff(request);
    if (handoff) return handoff;
    const response = /* 既存の処理 */ NextResponse.next();
    return clearCozeniHandoff(request, response);
  }
  ```

## 2. 限定ページ

ページ（Server Component）の最初で `requireEntitlement("<商品ID>")` を呼ぶ。権利が無ければ Cozeni の再入場画面へリダイレクトし、ハンドオフ直後などリダイレクトしてはいけない場合は `AccessDenied` を投げる。

```tsx
import { AccessDenied, requireEntitlement } from "@nulogic/cozeni-sdk/next";

export const dynamic = "force-dynamic";

export default async function Members() {
  try {
    await requireEntitlement("prd_...");
  } catch (error) {
    if (!(error instanceof AccessDenied)) throw error;
    return <p>表示できません（{error.reason}）</p>;
  }
  return <main>…限定コンテンツ…</main>;
}
```

- `catch` では `AccessDenied` だけを受ける。それ以外（Next.js の `redirect()` の例外）は必ず投げ直す。広い `try/catch` で包むとリダイレクトが効かない。
- `error.reason` は `no_session`（未ログイン）・`no_grant`（未購入）・`revoked`（権利の取り消し）・`unavailable`（一時障害）。`unavailable` では「時間をおいて再試行」と案内し、限定コンテンツを出さない。
- 認可の結果や限定コンテンツを静的生成・`unstable_cache` などリクエストをまたぐキャッシュに入れない。layout だけで守らず、各ページで呼ぶ。

## 3. Route Handler と Server Action

リダイレクトしない。`entitlement("<商品ID>")` の結果で分岐する。

```ts
import { denialResponse, entitlement } from "@nulogic/cozeni-sdk/next";

export async function GET() {
  const result = await entitlement("prd_...");
  if (!result.entitled) return denialResponse(result, "prd_...");
  return Response.json({ /* 限定データ */ }, { headers: { "Cache-Control": "private, no-store" } });
}
```

- Route Handler（JSON）は `denialResponse()` で 401 / 403 / 503 を返す（`enter_url` は本文に入る）。
- Server Action は Response を返さず、`{ ok: false, reason: result.reason }` のような plain object を返す。直接 POST されうるので、ページとは別に毎回 `entitlement()` を呼ぶ。

## 4. 購入ボタン

CLI が返した購入リンクを `<a>` で置くだけ。ルートも秘密も要らない。

```tsx
<a href="https://checkout.cozeni.net/checkout/...">購入する</a>
```

## 5. 購入者ポータルへのボタン（利用者が求めたときだけ）

購入した商品の一覧（Cozeni の購入者ポータル）へ送るボタンを置くときは、Route Handler で `portalRedirect("<クリエイターID>")` を返し、ボタンはそのルートへの `<a>` にする。クリエイターIDは `npx cozeni whoami --json` の `data.creator_id`（商品IDと同じく、サンドボックスと本番で値が違う）。

```ts
// app/portal/route.ts
import { portalRedirect } from "@nulogic/cozeni-sdk/next";

export const dynamic = "force-dynamic";

export function GET() {
  return portalRedirect("cre_...");
}
```

- ボタンは `<a href="/portal">` にする。`<Link>` にしない（prefetch で押す前にリンクが発行される）。ページの描画時に発行して `<a href>` に埋め込まない（60秒で切れる）。
- 戻り先をクエリから受け取る作りにしない。発行した URL をログに出さない。

## 6. 環境変数

| 変数 | 必要か |
|---|---|
| `COZENI_SITE_ORIGIN` | **購入者限定ページのとき必要**（機能フラグでは使わない）。自サイトのオリジン（ローカルと本番で値が違う）。`Host` ヘッダーから推測しない |
| `COZENI_ENVIRONMENT` | サンドボックスにつなぐときだけ `sandbox`（`status` の `data.environment` が `sandbox`）。本番では設定しない |
| `COZENI_API_ORIGIN` | 不要（既定が本番）。Cozeni を手元で動かす開発時だけ |
| `COZENI_API_KEY` | 機能フラグのときだけ必要（下の「7. 機能フラグ」）。購入者限定ページでは使わない |

Next.js 15 の middleware は、リダイレクト先のループバックのホスト名（`127.0.0.1`）を `localhost` に書き換える。15 のローカル開発では `COZENI_SITE_ORIGIN` とブラウザで開くURLを `localhost` に揃える（`127.0.0.1` だと購入者の Cookie が届かない）。

## 7. 機能フラグ

<!-- Cozeni の管理画面の商品詳細にある、機能フラグの導入プロンプトと同じ内容にする。片方を変えたらもう片方も直す。 -->

アプリの機能を、機能フラグの商品（`access_type: "feature"`）を購入した人だけに開く。`createCheckout`・`hasFeatureFlag` などは `@nulogic/cozeni-sdk/next` の関数で、**サーバー（Route Handler・Server Action・Server Component）だけで**呼ぶ。完全な説明は SDK の README の「機能フラグ」。

1. **前提を確かめる**：アプリにログインがあり、ログインのメールアドレスの本人確認が済んでいること。どちらかが無ければ組み込まず、理由を利用者に伝えて購入者限定ページにする。
2. **キーの発行を頼む**：利用者に、管理画面の **設定 → 開発者** で、権限「購入画面を作る」と「購入者の機能フラグを確かめる」の API キーを発行してもらい、サーバーの環境変数 `COZENI_API_KEY` に入れてもらう（手元の開発は `.env.local`、本番は本番の環境変数）。
   - キーの値を読まない・表示しない・コミットしない。`NEXT_PUBLIC_` で始まる環境変数にしない（ブラウザに渡る）。`.env.local` などが `.gitignore` に入っていることを確かめる。
   - サンドボックスのキー（`cozeni_sk_sandbox_` で始まる）なら、`COZENI_API_KEY` と同じ場所に `COZENI_ENVIRONMENT=sandbox` も入れてもらう。
3. **購入ボタン**：サーバーで `createCheckout` を呼び、返った `url` へ移す。`already_purchased`（409）は購入済みとして扱う。

   ```ts
   "use server";
   import { createCheckout } from "@nulogic/cozeni-sdk/next";
   import { redirect } from "next/navigation";

   export async function buy() {
     const user = await currentUser(); // ログイン中のユーザー（既存の認証）
     const checkout = await createCheckout({ productId: "prd_...", email: user.email });
     redirect(checkout.url);
   }
   ```

   サンドボックスで購入画面を作れるのは利用者本人（Cozeni のアカウントのメールアドレス）のメールだけで、ほかは `sandbox_recipient_not_allowed`（422）。試すときは、利用者本人のメールのアカウントでアプリにログインする。
4. **判定**：機能の画面と機能の API の両方で `hasFeatureFlag` を呼ぶ（画面で隠すだけにしない）。`granted` が false なら画面は購入を促し、機能の API は **403** を返す。

   ```ts
   import { hasFeatureFlag } from "@nulogic/cozeni-sdk/next";

   export async function POST() {
     const user = await currentUser();
     if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
     const { granted, metadata } = await hasFeatureFlag({ email: user.email, productId: "prd_..." });
     if (!granted) return Response.json({ error: "forbidden" }, { status: 403 });
     // metadata.daily_messages などの上限は、サーバーで数えて止める
   }
   ```

5. **設定値**：`metadata` はサーバーで読んで使い、上限などはサーバーで数える。秘密の置き場にはしない（管理画面と API の応答に平文で出る）。
6. **反映待ちとキャッシュ**：購入直後は反映に数秒かかる。見つからなければ 2 秒おきに最大 3 回、照会し直す。キャッシュは、サーバーのメモリに、付与済み（`granted: true`）の結果だけを最大 60 秒残す。未購入の結果と購入直後の再照会はキャッシュしない（README の「結果のキャッシュ」節）。
7. **確かめる**：購入していないユーザーで、機能の API が 403 になること。

## 以前の版（0.3系）で導入したサイト

`COZENI_PRODUCT_ID` などの環境変数と `requireEntitlement({ apiOrigin, productId, haltRedirect })`、handoff の Route Handler はそのまま動く。移行は必須ではない。移行する場合は、handoff と Cookie 消去のルート・ページ内の `cozeni_code` 転送と印の処理を削除し、上の 1〜4 に置き換える。
