# JavaScript / TypeScriptサーバーへの実装

Next.js App Router以外の構成では、対象フレームワークのサーバー実行方式を確認してから、配布package内の [`examples/javascript-server`](../../../examples/javascript-server) を参照する。`web-handler.mjs` はWeb標準 `Request` / `Response` の例、`node-server.mjs` はNode.js HTTPへのadapter例であり、既存アプリ全体を置き換えるtemplateではない。

## 実装できる構成

Node.jsサーバー、SSR、serverless function、edge function、Workerのように、サーバーでCookieを読み、`Set-Cookie` と303 redirectを返せる構成が必要である。さらに、保護HTMLだけでなく、限定データを返すAPI・loader・action・mutationをサーバー側で拒否できなければならない。

静的ファイルだけを配るSPAはこの条件を満たさない。既存のserverless機能などのサーバー境界を特定できない場合は、バックエンド追加が必要であることを伝えて実装を止める。

## フレームワークへの写像

1. 商品IDと購入リンクは、CLI（`npx cozeni products create` / `link`）の出力をコードに直接書く。購入ボタンは購入リンクへの `<a>` でよい。サーバー設定から読むのは `COZENI_SITE_ORIGIN`（自サイトのオリジン）だけで、APIオリジンは本番の `https://api.cozeni.net` を使う。`status` の `data.environment` が `sandbox` なら `createCustomerClient({ environment: "sandbox" })` でサンドボックスにつなぐ（環境変数 `COZENI_ENVIRONMENT` から渡し、本番では外せるようにする）。Cozeniを手元で動かす開発時だけ `COZENI_API_ORIGIN` で差し替える。例は設定値をすべて環境変数から読むが、商品IDとリンクは定数にしてよい。再入場先（メールアドレス入力画面）は設定不要で、`checkEntitlement()` の拒否応答に含まれる `result.enterUrl` をそのまま使う。
2. 購入後URLで受けた `cozeni_code` をサーバーrouteで `exchangeHandoff()` に渡す。`customerCookie()` の値を `Set-Cookie` に設定し、信頼済みsite originへ303で戻す。戻り先URLには、ハンドオフ成功直後を示す秘密を含まない印（`cozeni_handoff=1`）を付ける（4を参照）。
3. 保護ページと各データ入口で `checkEntitlement()` を呼ぶ。受信CookieはSDKへ渡せるが、SDKがCozeniへ転送するのは `cozeni_customer` だけである。HTMLを返すページ入口では、拒否結果を `enterRedirectResponse(result, productId)`（`@nulogic/cozeni-sdk`）へ渡すと、`result.enterUrl` が実際に問い合わせた`productId`を指しているときだけWeb標準Responseの303リダイレクトを得られる。JSON APIを返す入口ではこの関数を使わず、`enterUrl` はJSON本文（`enter_url`として）へ含めるだけにしてリダイレクトしない（fetchの呼び出し元をHTMLへ飛ばさないため）。
4. **無限リダイレクトの回避**: ハンドオフのコード交換直後（`cozeni_code`を処理した直後のリクエスト、成功直後の`cozeni_handoff`付きリクエスト、または交換失敗で`cozeni_error`が付いたリクエスト）では、`enterUrl`があっても再リダイレクトせず拒否画面に留める。`cozeni_handoff`付きで権利が確認できた場合は、印を外したURLへ正規化する（表示だけに留めてもよい）。実装は [`examples/javascript-server/web-handler.mjs`](../../../examples/javascript-server/web-handler.mjs) の `members()` を正本にする。
5. 購入者ポータル（購入した商品の一覧）へのボタンを利用者が求めたときは、ボタンを `/portal` のようなサーバーrouteへの `<a>` にし、そのrouteで `createPortalLink({ cookieHeader, creatorId })` を呼んで返ったURLへ302で送る。`no_session` ならコード無しのポータルへ302で送り、それ以外の失敗は503にする（README の「購入者ポータルへ送る」）。描画時に発行して埋め込まず、戻り先をクエリから受け取らない。
6. 認可応答、handoff、保護データは `private, no-store` とする。Hostやforwarded hostからredirect先を作らず、コード・Cookie・token・例外本文をログへ残さない。

ExpressやFastify等で独自Requestを使う場合は、必要なmethod・URL・Cookie headerだけをWeb標準 `Request` へ変換する。Hono、Nuxt、SvelteKit、Astro SSR、React Router、Cloudflare Workers等でWeb標準APIを扱える場合は、既存のrouteやloaderへ同じ境界を組み込む。フレームワーク固有の認証、CSRF、middleware、error handlingは維持する。

各保護入口には、未認証（`no_session`）・権利なし（`no_grant`）・権利の取り消し（`revoked`）・一時障害（`unavailable`）の拒否分岐を対応付ける。`unavailable` を再入場の要求に変えない。例のunit testだけで、対象アプリの入口が保護されたとは判断しない。

## 機能フラグ

アプリの機能を購入者だけに開くときは、サーバーで `createManagementClient({ apiKey: process.env.COZENI_API_KEY, environment })`（サンドボックスのキーは `COZENI_ENVIRONMENT=sandbox` と組）の `createCheckout({ productId, email })` と `hasFeatureFlag({ email, productId })` を使う（Next.js は [nextjs.md](nextjs.md) の「7. 機能フラグ」）。

- キーは利用者が発行（権限は「購入画面を作る」「購入者の機能フラグを確かめる」）してサーバーの環境変数だけに入れる。ブラウザに渡さず、値を読まない・書かない。ログインとメールアドレスの本人確認が無いサイトでは使わない。
- 機能の画面と機能の API の両方で `hasFeatureFlag` を呼び、`granted` が false なら API は 403 を返す。設定値（`metadata`）と上限はサーバーで扱う。
- 購入直後は2秒おきに最大3回照会し直す。結果は最大60秒キャッシュしてよい。
