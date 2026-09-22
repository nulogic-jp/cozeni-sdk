# Next.js App Routerへの実装

このリポジトリの [`examples/nextjs`](../../../examples/nextjs) は、買い切り1商品・保護ページ1つの実行例である。対象アプリのNext.js / React版、`src/`有無、既存のmiddlewareまたはproxy、認証、runtimeに合わせ、例全体で既存アプリを上書きしない。

## 設定をアプリへ取り込む

導入プロンプトが確定した非秘密の `apiOrigin`、`siteOrigin`、`productId`、`checkoutUrl` を、対象アプリの既存のサーバー環境変数方式で読む。購入ボタンは標準checkout URLへ接続し、購入者runtimeでは `createCustomerClient({ apiOrigin })` を使う。

商品登録helperが `.cozeni/setup-state.json` を完了状態で保存した場合は、対象アプリのcwdで次を実行する。

```sh
node "$SKILL_DIR/scripts/configure-next.mjs" .cozeni/setup-state.json .env.local
```

このscriptは `COZENI_API_ORIGIN`、`COZENI_SITE_ORIGIN`、`COZENI_PRODUCT_ID`、`COZENI_CHECKOUT_URL` だけを更新し、既存の認証・秘密設定を保持する。既存サイトの変数名が異なる場合は、同じ非秘密値をその方式へ対応付ける。設定中に他のプロセスから同じファイルを編集しない。

`COZENI_OTP_URL` は、導入プロンプトで確認済みのCozeni Web originと保存状態の `productId` から、`URL` / `URLSearchParams` を使って `/enter?product_id=...` として構成する。API originや購入URLのパスから推測せず、管理画面と購入者入場面が別originなら実際の入場originを使う。保護コンテンツを環境変数で扱う例では、`COZENI_PROTECTED_CONTENT` もサーバー専用とする。

## App Routerの入口へ組み込む

- **handoff Route Handler**: `cozeni_code` を受けるサーバー入口で `exchangeHandoff()` を一度だけ呼び、`customerCookie()` の値を `Set-Cookie` へ設定して、コードのないURLへ303で遷移する。成功応答とhandoff応答は共有キャッシュしない。
- **Pageからhandoffへの転送**: `cozeni_code` をPageまたはRSCでhandoff Route Handlerへ渡すときは、設定URLの生成だけを `try/catch` し、`redirect(callback.href)` は必ず `catch` の外で実行する。Next.jsの `redirect()` は `NEXT_REDIRECT` をthrowする制御フローのため、広い `catch` で捕捉すると交換入口へ到達しない。実装は [`examples/nextjs/app/members/page.tsx`](../../../examples/nextjs/app/members/page.tsx) を正本にする。
- **ページとRSC**: 保護コンポーネントの構築・データ取得より先に権利を確認する。layoutだけに依存しない。認可結果や保護データを静的生成、`unstable_cache`、リクエストをまたぐcacheへ保存しない。
- **データ取得・Route Handler・Server Action**: 各入口で独立に `checkEntitlement()` を呼ぶ。Server Actionの副作用には、購入者認可に加えて既存のCSRF / Origin検査を維持する。
- **Cookie操作とredirect**: `siteOrigin` はサーバー設定から固定し、受信したHostやforwarded headerから作らない。Cookie消去など通常ページのフォームには `Referrer-Policy: strict-origin` を使う。handoff応答の `no-referrer` は維持する。
- **キャッシュ**: 保護ページ・保護API・handoff・Cookie操作の応答は `no-store` にし、静的JS / CSSのキャッシュは維持する。RSC要求を含む未認証応答に保護内容が入らないようにする。

既存のログインCookieは置き換えず、SDKへは `cozeni_customer` だけを渡す。認可結果に応じた既存アプリの画面・エラー形式を保ちながら、保護内容または副作用を返さない分岐を各入口に実装する。
