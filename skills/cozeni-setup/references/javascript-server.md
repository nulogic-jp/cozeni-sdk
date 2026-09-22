# JavaScript / TypeScriptサーバーへの実装

Next.js App Router以外の構成では、対象フレームワークのサーバー実行方式を確認してから、配布package内の [`examples/javascript-server`](../../../examples/javascript-server) を参照する。`web-handler.mjs` はWeb標準 `Request` / `Response` の例、`node-server.mjs` はNode.js HTTPへのadapter例であり、既存アプリ全体を置き換えるtemplateではない。

## 実装できる構成

Node.jsサーバー、SSR、serverless function、edge function、Workerのように、サーバーでCookieを読み、`Set-Cookie` と303 redirectを返せる構成が必要である。さらに、保護HTMLだけでなく、限定データを返すAPI・loader・action・mutationをサーバー側で拒否できなければならない。

静的ファイルだけを配るSPAはこの条件を満たさない。既存のserverless機能などのサーバー境界を特定できない場合は、バックエンド追加が必要であることを伝えて実装を止める。

## フレームワークへの写像

1. サーバー専用設定から `COZENI_API_ORIGIN`、`COZENI_SITE_ORIGIN`、`COZENI_PRODUCT_ID`、`COZENI_CHECKOUT_URL` を読む。購入ボタンは `COZENI_CHECKOUT_URL` へ接続する。
2. 購入後URLで受けた `cozeni_code` をサーバーrouteで `exchangeHandoff()` に渡す。`customerCookie()` の値を `Set-Cookie` に設定し、信頼済みsite originのコードなしURLへ303で戻す。
3. 保護ページと各データ入口で `checkEntitlement()` を呼ぶ。受信CookieはSDKへ渡せるが、SDKがCozeniへ転送するのは `cozeni_customer` だけである。
4. 認可応答、handoff、保護データは `private, no-store` とする。Hostやforwarded hostからredirect先を作らず、コード・Cookie・token・例外本文をログへ残さない。

ExpressやFastify等で独自Requestを使う場合は、必要なmethod・URL・Cookie headerだけをWeb標準 `Request` へ変換する。Hono、Nuxt、SvelteKit、Astro SSR、React Router、Cloudflare Workers等でWeb標準APIを扱える場合は、既存のrouteやloaderへ同じ境界を組み込む。フレームワーク固有の認証、CSRF、middleware、error handlingは維持する。

各フレームワークで使う保護入口には、導入プロンプトで指定された未認証・権利なし・権利剥奪・一時障害の拒否分岐を対応付ける。例のunit testだけで、対象アプリの入口が保護されたとは判断しない。
