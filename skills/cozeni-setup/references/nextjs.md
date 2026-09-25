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
<a href="https://app.cozeni.net/checkout/...">購入する</a>
```

## 5. 環境変数

| 変数 | 必要か |
|---|---|
| `COZENI_SITE_ORIGIN` | **必要**。自サイトのオリジン（ローカルと本番で値が違う）。`Host` ヘッダーから推測しない |
| `COZENI_API_ORIGIN` | 不要（既定が本番）。Cozeni を手元で動かす開発時だけ |

Next.js 15 の middleware は、リダイレクト先のループバックのホスト名（`127.0.0.1`）を `localhost` に書き換える。15 のローカル開発では `COZENI_SITE_ORIGIN` とブラウザで開くURLを `localhost` に揃える（`127.0.0.1` だと購入者の Cookie が届かない）。

## 以前の版（0.3系）で導入したサイト

`COZENI_PRODUCT_ID` などの環境変数と `requireEntitlement({ apiOrigin, productId, haltRedirect })`、handoff の Route Handler はそのまま動く。移行は必須ではない。移行する場合は、handoff と Cookie 消去のルート・ページ内の `cozeni_code` 転送と印の処理を削除し、上の 1〜4 に置き換える。
