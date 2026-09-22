# JavaScriptサーバー向け導入例

Web標準の `Request` / `Response` を扱えるJavaScript／TypeScriptサーバーと、Node.js HTTPサーバー向けの最小例です。

## 対象と境界

- `web-handler.mjs` は、保護ページ、保護API、handoff code交換をWeb標準APIで実装します。
- `node-server.mjs` は、Node.jsの受信要求をWeb標準 `Request` へ変換します。`Host` ヘッダーをredirect先の生成に使いません。
- APIキーは商品登録などの管理操作だけに使い、必ずサーバー環境変数へ置きます。この購入者向け例はAPIキーを使用しません。
- 購入者Cookieは `HttpOnly` で設定し、権利確認時はCozeni用CookieだけをSDKが転送します。
- 権利なし、Cookieなし、Cozeni障害のいずれも限定コンテンツを返しません。
- 応答は `private, no-store` とし、handoff codeは交換後のredirectでURLから除去します。
- 静的SPAだけでは限定HTML、JSON、画像等を安全に保護できません。信頼できるサーバー、serverless function、またはWorkerが必要です。

## 実行

SDKリポジトリ直下でbuild後、次の非秘密設定を自分の環境に合わせます。実際の限定本文は秘密情報として扱い、公開リポジトリへcommitしないでください。

```sh
export COZENI_API_ORIGIN=https://api.example.com
export COZENI_SITE_ORIGIN=http://127.0.0.1:3100
export COZENI_PRODUCT_ID=prod_example
export COZENI_CHECKOUT_URL=https://checkout.example.com/buy/example
export COZENI_PROTECTED_CONTENT='購入者限定の本文'
bun run build
node examples/javascript-server/node-server.mjs
```

商品登録用の `COZENI_API_KEY` は、このサーバープロセスやブラウザーへ渡さないでください。管理処理を同じバックエンドへ追加する場合も、APIキーをHTML、公開環境変数、クライアントbundle、ログへ含めません。

商品に登録するアクセスURLは `https://自サイト/members` とします。Cozeniから `cozeni_code` 付きで戻ると、内部handoff routeへ転送し、コードを購入者tokenへ交換してからコードなしの `/members` へ戻します。

SDKのsource checkoutにはNode.js標準test runner用の回帰テストがあります。テストコードは配布packageには含めません。

```sh
node --test examples/javascript-server/web-handler.test.mjs
```

Express、Fastify、Hono、Nuxt、SvelteKit、Astro SSR、React Router、Cloudflare Workers等では、`createWebHandler()` に各環境のWeb標準 `Request` を渡してください。フレームワーク側で保護データを別routeやloaderから返す場合、その境界でも毎回 `checkEntitlement()` を実行してください。
