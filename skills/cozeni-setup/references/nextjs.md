# Next.js App Routerへの実装

このリポジトリの [`examples/nextjs`](../../../examples/nextjs) は、買い切り1商品・保護ページ1つの実行例である。対象アプリのNext.js / React版、`src/`有無、既存のmiddlewareまたはproxy、認証、runtimeに合わせ、例全体で既存アプリを上書きしない。

## 設定をアプリへ取り込む

導入プロンプトが確定した非秘密の `apiOrigin`、`siteOrigin`、`productId`、`checkoutUrl` を、対象アプリの既存のサーバー環境変数方式で読む。購入ボタンは標準checkout URLへ接続し、購入者runtimeでは `createCustomerClient({ apiOrigin })` を使う。

商品登録helperが `.cozeni/setup-state.json` を完了状態で保存した場合は、対象アプリのcwdで次を実行する。

```sh
node "$SKILL_DIR/scripts/configure-next.mjs" .cozeni/setup-state.json .env.local
```

このscriptは `COZENI_API_ORIGIN`、`COZENI_SITE_ORIGIN`、`COZENI_PRODUCT_ID`、`COZENI_CHECKOUT_URL` だけを更新し、既存の認証・秘密設定を保持する。既存サイトの変数名が異なる場合は、同じ非秘密値をその方式へ対応付ける。設定中に他のプロセスから同じファイルを編集しない。

購入者の再入場先（メールアドレス入力画面）は、Cozeniの権利確認APIが拒否応答へ含める `enter_url` を `@nulogic/cozeni-sdk/next` がそのまま使う。クリエイター側で再入場URLを設定・構成する必要はなく、`COZENI_OTP_URL` 相当の環境変数も不要である。保護コンテンツを環境変数で扱う例では、`COZENI_PROTECTED_CONTENT` もサーバー専用とする。

## App Routerの入口へ組み込む

`@nulogic/cozeni-sdk/next`（サブパスexport）がcookies()の読み取りからenter_urlへの自動リダイレクトまで行う。共通SDK本体（`@nulogic/cozeni-sdk`）はフレームワーク非依存のまま、Next.js固有の処理だけがこちらに閉じている。

- **handoff Route Handler**: `cozeni_code` を受けるサーバー入口で `exchangeHandoff()` を一度だけ呼び、`customerCookie()` の値を `Set-Cookie` へ設定して、ハンドオフ成功直後を示す秘密を含まない印（`cozeni_handoff=1`）を付けたURLへ303で遷移する。成功応答とhandoff応答は共有キャッシュしない。
- **Pageからhandoffへの転送**: `cozeni_code` をPageまたはRSCでhandoff Route Handlerへ渡すときは、設定URLの生成だけを `try/catch` し、`redirect(callback.href)` は必ず `catch` の外で実行する。Next.jsの `redirect()` は `NEXT_REDIRECT` をthrowする制御フローのため、広い `catch` で捕捉すると交換入口へ到達しない。`cozeni_code`が重複クエリ（`string[]`）で届いた場合も無効なコードとして扱う。実装は [`examples/nextjs/app/members/page.tsx`](../../../examples/nextjs/app/members/page.tsx) を正本にする。
- **ページとRSC（リダイレクトするのはここだけ）**: `requireEntitlement({ apiOrigin, productId, haltRedirect })` を保護コンポーネントの構築・データ取得より先に呼ぶ。権利があれば何もせず戻り、権利が無くenter_urlが使えれば`redirect()`の制御フロー例外を投げて自動遷移する。この呼び出しは`AccessDenied`だけを捕捉し、それ以外（`redirect()`の例外を含む）は握りつぶさず上位へ伝播させる。layoutだけに依存しない。認可結果や保護データを静的生成、`unstable_cache`、リクエストをまたぐcacheへ保存しない。redirect()を使うのはこのpage入口だけで、Server ActionやRoute Handlerでは使わない。
- **無限リダイレクトの回避（haltRedirect）**: ハンドオフのコード交換直後（`cozeni_code`を処理した直後のリクエスト、成功直後の`cozeni_handoff`付きリクエスト、または交換失敗で`cozeni_error`が付いたリクエスト）では`haltRedirect: true`を渡す。重複クエリで`string[]`になっていても「印がある」とみなす。この状態で拒否されると`requireEntitlement()`は再リダイレクトせず`AccessDenied`を投げるので、呼び出し側はサイト内の拒否表示に留める。`cozeni_handoff`付きで権利が確認できた場合は、印を外したURLへ`redirect()`で正規化する。
- **データ取得・Server Action（redirectしない、denialResponse()も使わない）**: 各入口で独立に認可する。`nextEntitlement()`（redirectしない）や、上記の保護データ取得ヘルパーを再利用し、拒否は`AccessDenied`で受け取る。Server ActionはWeb Responseを返すべきではないため、`AccessDenied.reason`（または`nextEntitlement()`の結果）をそのままplain objectとして返し、呼び出し元のクライアントコンポーネントで表示を切り替える。実装は [`examples/nextjs/app/members/actions.ts`](../../../examples/nextjs/app/members/actions.ts) を正本にする。Server Actionの副作用には、購入者認可に加えて既存のCSRF / Origin検査を維持する。
- **Route Handler（JSON API、redirectしない）**: リダイレクトせず、`denialResponse(entitlement, productId)`で401/403/503のJSONへ`enter_url`を含めて返す。`productId`は実際に問い合わせたIDを渡す（enter_urlのproduct_id一致検証に使う）。fetchの呼び出し元をHTMLへ飛ばさないため、Route Handlerの中では`redirect()`を呼ばない。
- **Cookie操作とredirect**: `siteOrigin` はサーバー設定から固定し、受信したHostやforwarded headerから作らない。Cookie消去など通常ページのフォームには `Referrer-Policy: strict-origin` を使う。handoff応答の `no-referrer` は維持する。
- **キャッシュ**: 保護ページ・保護API・handoff・Cookie操作の応答は `no-store` にし、静的JS / CSSのキャッシュは維持する。RSC要求を含む未認証応答に保護内容が入らないようにする。

既存のログインCookieは置き換えず、SDKへは `cozeni_customer` だけを渡す。認可結果に応じた既存アプリの画面・エラー形式を保ちながら、保護内容または副作用を返さない分岐を各入口に実装する。
