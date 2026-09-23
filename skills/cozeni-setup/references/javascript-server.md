# JavaScript / TypeScriptサーバーへの実装

Next.js App Router以外の構成では、対象フレームワークのサーバー実行方式を確認してから、配布package内の [`examples/javascript-server`](../../../examples/javascript-server) を参照する。`web-handler.mjs` はWeb標準 `Request` / `Response` の例、`node-server.mjs` はNode.js HTTPへのadapter例であり、既存アプリ全体を置き換えるtemplateではない。

## 実装できる構成

Node.jsサーバー、SSR、serverless function、edge function、Workerのように、サーバーでCookieを読み、`Set-Cookie` と303 redirectを返せる構成が必要である。さらに、保護HTMLだけでなく、限定データを返すAPI・loader・action・mutationをサーバー側で拒否できなければならない。

静的ファイルだけを配るSPAはこの条件を満たさない。既存のserverless機能などのサーバー境界を特定できない場合は、バックエンド追加が必要であることを伝えて実装を止める。

## フレームワークへの写像

1. サーバー専用設定から `COZENI_API_ORIGIN`、`COZENI_SITE_ORIGIN`、`COZENI_PRODUCT_ID`、`COZENI_CHECKOUT_URL` を読む。購入ボタンは `COZENI_CHECKOUT_URL` へ接続する。再入場先（メールアドレス入力画面）はクリエイター側で設定不要で、`checkEntitlement()` の拒否応答に含まれる `result.enterUrl`（wire上は`enter_url`。SDKはcamelCaseへ写像する）をそのまま使う。
2. 購入後URLで受けた `cozeni_code` をサーバーrouteで `exchangeHandoff()` に渡す。`customerCookie()` の値を `Set-Cookie` に設定し、信頼済みsite originへ303で戻す。戻り先URLには、ハンドオフ成功直後を示す秘密を含まない印（`cozeni_handoff=1`）を付ける（4を参照）。
3. 保護ページと各データ入口で `checkEntitlement()` を呼ぶ。受信CookieはSDKへ渡せるが、SDKがCozeniへ転送するのは `cozeni_customer` だけである。HTMLを返すページ入口では、拒否結果を `enterRedirectResponse(result, productId)`（`@nulogic/cozeni-sdk`）へ渡すと、`result.enterUrl` が実際に問い合わせた`productId`を指しているときだけWeb標準Responseの303リダイレクトを得られる。JSON APIを返す入口ではこの関数を使わず、`enterUrl` はJSON本文（`enter_url`として）へ含めるだけにしてリダイレクトしない（fetchの呼び出し元をHTMLへ飛ばさないため）。
4. **無限リダイレクトの回避**: ハンドオフのコード交換直後（`cozeni_code`を処理した直後のリクエスト、成功直後の`cozeni_handoff`付きリクエスト、または交換失敗で`cozeni_error`が付いたリクエスト）では、`enterUrl`があっても再リダイレクトせず拒否画面に留める。`cozeni_handoff`付きで権利が確認できた場合は、印を外したURLへ正規化する（表示だけに留めてもよい）。実装は [`examples/javascript-server/web-handler.mjs`](../../../examples/javascript-server/web-handler.mjs) の `members()` を正本にする。
5. 認可応答、handoff、保護データは `private, no-store` とする。Hostやforwarded hostからredirect先を作らず、コード・Cookie・token・例外本文をログへ残さない。

ExpressやFastify等で独自Requestを使う場合は、必要なmethod・URL・Cookie headerだけをWeb標準 `Request` へ変換する。Hono、Nuxt、SvelteKit、Astro SSR、React Router、Cloudflare Workers等でWeb標準APIを扱える場合は、既存のrouteやloaderへ同じ境界を組み込む。フレームワーク固有の認証、CSRF、middleware、error handlingは維持する。

各フレームワークで使う保護入口には、導入プロンプトで指定された未認証・権利なし・権利剥奪・一時障害の拒否分岐を対応付ける。例のunit testだけで、対象アプリの入口が保護されたとは判断しない。
