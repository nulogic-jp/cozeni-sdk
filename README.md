# @nulogic/cozeni-sdk

Cozeni外部API v1用のサーバー向けJavaScript / TypeScript SDKと、商品や販売状態を操作するCLIです。Node.js 20以降、標準fetchを持つサーバー環境で動作します。SDK本体はNext.jsに依存しません。公開npmレジストリで配布しています。

| | 用途 | 管理キー |
|---|---|---|
| CLI（`npx @nulogic/cozeni-sdk`） | ログイン、商品の作成・更新、購入リンクの取得、販売状態の確認 | ログインで取得（手元にだけ保存） |
| 管理API | 商品の作成・更新・取得、購入リンクの発行 | 必要 |
| 購入者API | Cookieから購入権限を判定し、保護コンテンツの表示可否を決める | 不要 |
| ハンドオフ | Cozeniの単回コードを自サイトのCookieへ交換 | 不要 |
| `@nulogic/cozeni-sdk/next` | Next.js 15・16でのハンドオフ・認可・リダイレクト | 不要 |

**本番のサイトは管理キーを使いません。** 管理操作は手元のCLIで行い、サイトには購入者API（キー不要）だけを組み込みます。

## インストール

対象サイトがすでに使用しているpackage managerで依存へ追加します。**取得に認証は必要ありません。**

```sh
npm install @nulogic/cozeni-sdk
# または: bun add / pnpm add / yarn add @nulogic/cozeni-sdk
```

コーディングAIに導入を任せる場合は、skillもプロジェクトへ追加します（[skills](https://github.com/vercel-labs/skills) CLIを使用）。追加されたskillはプロジェクトと一緒にcommitしてください。

```sh
npx skills add nulogic-jp/cozeni-sdk
```

skill（[`skills/cozeni-setup/`](skills/cozeni-setup/SKILL.md)）は、いつどのCLIを呼ぶか、コードのどこに何を書くかをAIに伝えます。frontmatterの `metadata.cozeni-sdk-version` に対応するSDKの版の範囲があり、CLIは起動時にこれを照合して、ずれていれば更新を促します。

Cozeniの管理画面（**設定 → 開発者**）の導入プロンプトは、この流れ（SDKとskillの追加、CLIでのログインと商品の作成、コードの配置）をAIに指示します。導入プロンプトを使わず、以下のリファレンスだけを見て自分で実装することもできます。その場合も `examples/` の実装が完全な参照になります。

## CLI

```sh
npx @nulogic/cozeni-sdk <コマンド> [--json] [--profile <名前>] [--yes]
```

bin名は `cozeni` ですが、案内や自動化では **`npx @nulogic/cozeni-sdk` を使ってください。** スコープなしの `npx cozeni` は、SDKが入っていないディレクトリでは同名の別パッケージを取得して実行しうるためです。スコープ付きの名前なら、プロジェクトに入っている版を、無ければNulogicが公開した版を使います。

| コマンド | 役割 |
|---|---|
| `login` | ログインを始める。承認用のURLとコードを表示する |
| `login --complete` | 承認を確かめ、キーを保存する |
| `logout` | サーバー側でキーを失効させ、手元の認証情報を消す |
| `whoami` | 接続先の環境・クリエイター・キーの期限を表示 |
| `status` | 販売できる状態か（`sales`）、次にやること（`next_actions`）、商品一覧、キーの期限 |
| `products list` | 商品一覧 |
| `products create --name <名前> --price <円> --access-url <URL>` | 商品を作成し、標準の購入リンクを返す |
| `products update <商品ID> [--name] [--price] [--access-url]` | 商品を変更する |
| `link <商品ID>` | 標準の購入リンクを取得する（無ければ発行） |

### ログイン

デバイスコード方式（RFC 8628）です。利用者はブラウザで表示されたコードを確かめて「許可」を押すだけで、キーを手で受け渡しません。

AIエージェントのシェルはコマンドが終わるまで出力を返さないことが多いため、非対話では2段階で動きます。

1. `login` はコードを発行してすぐ終了します（期限内に再実行すると同じコードを出し直します）。
2. 利用者が承認したら、`login --complete` が最長90秒ポーリングしてキーを保存します。承認前なら終了コード6で戻るので、同じコマンドを打ち直します。

TTYがあり、AIエージェントの実行環境（`CLAUDECODE`・`CURSOR_AGENT`・`CODEX_*` などの環境変数）やCIでなければ、1段階でコードを表示して承認を待ちます（Enterでブラウザを開きます）。

ログインで得るキーは商品と購入リンクの操作に限られ、**発行から30日で失効します**（使っても延長されません）。ログインし直すと、新しいキーを保存したあとで前のキーを失効させます。

### 出力と終了コード

`--json` を付けると、1行のJSONを標準出力に出します。秘密（APIキー）はどの出力にも含めません。

```json
{"ok":true,"data":{}}
{"ok":false,"error":{"code":"login_required","message":"…","hint":"npx @nulogic/cozeni-sdk login を実行してください。"}}
```

| 終了コード | 意味 | 代表的な `error.code` |
|---|---|---|
| 0 | 成功 | — |
| 1 | 想定外のエラー | `internal`・`invalid_response`・`insecure_storage` |
| 2 | 使い方の誤り・確認が必要 | `invalid_input`・`confirmation_required`・`origin_mismatch` |
| 3 | ログインが必要 | `login_required`・`key_expired`・`access_denied`・`expired_token` |
| 4 | 権限・規約・状態で拒否 | `terms_consent_required`・`forbidden`・`not_found`・`product_archived`・`idempotency_conflict` |
| 5 | 通信できない・一時障害 | `network_unreachable`・`unexpected_redirect`・`rate_limited`・`unavailable` |
| 6 | 承認待ち | `authorization_pending` |

通信できないときは、Codex cloud や Claude Code on the web などクラウドで動くツール向けに、`api.cozeni.net` への通信を許可する手順を `hint` に示します。429では `retry_after_seconds` を返します。

### 確認が必要な操作

商品の作成、価格の変更、`access_url`（購入後に表示するページ）の変更は、`--yes` が無ければ実行しません。`access_url` の変更は既存の購入者全員にすぐ反映されるためです。TTYでは変更前後を示して確認を求め、TTYが無ければ `confirmation_required` で止まります（確認する内容は `error.details`）。AIは利用者に確認してから `--yes` を付けて実行します。

`products create` は入力ごとに冪等キーを保存してから送信します。タイムアウトなどで結果が分からないときは、同じコマンドをそのまま再実行すれば、商品が二重に作られません。冪等キーは成功後も24時間残し、その間に同じ入力で再実行すると、作成済みの商品を返します（`data.reused: true`）。24時間を過ぎたキーはCLIの起動時に消します。価格は50円から9,999,999円までの整数です。

### 認証情報の保存先

`$XDG_CONFIG_HOME/cozeni/`（未設定なら `~/.config/cozeni/`）に保存します。プロジェクトの中には置きません。

- `credentials.json`：プロファイルごとのキーと接続先。平文ですが、ディレクトリ0700・ファイル0600で書きます。
- `pending/`：ログインの待ち状態と、未完了の冪等キー。
- 書き込みは一時ファイルを経由して置き換えます。シンボリックリンクや、所有者以外が読める権限のファイルを見つけたら、読み書きせずに止まります。

**Windowsではファイル権限の検査を行いません**（権限ビットで所有者だけに絞れないため）。Windowsでは `XDG_CONFIG_HOME` を共有フォルダや同期フォルダに向けないでください。

キーは発行された接続先にだけ送ります。`production`（既定）の接続先は `https://api.cozeni.net` と `https://app.cozeni.net` に固定です。キーを付けた要求はリダイレクトを追いません。

環境変数 `COZENI_API_KEY` があれば、保存したキーより優先して使います（CIなど向け）。`logout` はこのキーを失効させません。

## 管理API
## 管理API

```ts
import {createManagementClient} from '@nulogic/cozeni-sdk';

const client = createManagementClient({
  apiOrigin: process.env.COZENI_API_ORIGIN!,
  apiKey: process.env.COZENI_API_KEY!,
});

const product = await client.products.create(
  {name: '商品名', price_jpy: 1000, access_url: 'https://example.com/members'},
  {idempotencyKey: '保存済みの冪等キー'},
);
const link = await client.checkoutLinks.get(product.id);
```

ほかに `account.get`、`products.list` / `get` / `update`、`checkoutLinks.ensure` があります。`price_jpy` は円をそのまま渡します。`create` の冪等キーはPOSTより前に保存し、応答を失っても同じ入力・同じキーで再送します（自動リトライはありません）。

管理キーはサーバー環境変数のみに置き、ブラウザや `NEXT_PUBLIC_*` へ渡しません。

## 購入者API

```ts
import {createCustomerClient} from '@nulogic/cozeni-sdk';

const customer = createCustomerClient({apiOrigin: process.env.COZENI_API_ORIGIN!});

const result = await customer.checkEntitlement({
  productId: '商品ID',
  cookieHeader: request.headers.get('cookie') ?? undefined,
});

if (!result.entitled) {
  // no_session / no_grant / revoked / unavailable に応じて拒否する
  // no_session / no_grant / revoked には、result.enterUrl（メールアドレス
  // 入力画面への絶対URL）が付くことがあります。
}
```

`cozeni_customer` Cookieだけを読み、既存の認証CookieはCozeniへ転送しません。未認証・無効応答・通信障害・タイムアウトのいずれでも許可せず、`unavailable`（Cozeni側の障害）を購入要求へ変換しないでください。**`unavailable`には`enterUrl`が付きません**（障害を再認証要求に変換しないため）。

`enterUrl`はAPI応答をそのまま信頼するのではなく、SDKが構造で検証してから採用します（httpsが必須、httpはlocalhost・127.0.0.1・[::1]のloopbackだけ許可、userinfo無し、pathnameは`/enter`固定、クエリは問い合わせた`productId`と一致する`product_id`の1個だけ、fragment無し）。SDKの設定にweb originを足さない方針のため、許可originの列挙ではなく構造で縛っています。APIオリジン自体は、TLS（HTTPS）で取得した応答を信頼する前提です。合わない値は省略されます（リダイレクトしません）。

拒否結果からリダイレクト先を組み立てるフレームワーク非依存のヘルパーもあります。第2引数には、この結果を問い合わせた`productId`を渡してください（`enterUrl`が実際にその商品を指しているかを再検証するため）。

```ts
import {enterRedirectUrl, enterRedirectResponse} from '@nulogic/cozeni-sdk';

const target = enterRedirectUrl(result, productId); // URL | undefined
const response = enterRedirectResponse(result, productId); // Web標準Response(303) | undefined
```

`enterRedirectResponse` はHTMLを返すページ入口向けです。JSON APIを返す入口では使わず、`enter_url` はJSON本文へ含めるだけにしてリダイレクトしないでください（fetchの呼び出し元をHTMLへ飛ばさないため）。無限リダイレクトを避けるため、ハンドオフのコード交換直後（`cozeni_code`を処理した直後のリクエスト、成功直後のマーカー付きリクエスト、または交換失敗で`cozeni_error`が付いたリクエスト）では、`enter_url`があっても再リダイレクトせず拒否画面に留めてください。

`exchangeHandoff(code)` は60秒・単回のコードを `{token}` へ交換します。結果は `customerCookie` で自サイトのHttpOnly Cookieへ保存します。信頼originはサーバー設定から指定し、Hostヘッダーから組み立てません。

両clientに `fetch` と `timeoutMs`（既定10秒）を注入できます。エラーは `CozeniError`（`code` / `status` / `requestId` / `retryAfterSeconds`）で、秘密や生の応答を保持しません。

## JavaScript / TypeScriptサーバーの導入例

[`examples/javascript-server`](examples/javascript-server) に、Web標準 `Request` / `Response` の保護ハンドラーとNode.js HTTP接続例があります。Express、Fastify、Hono、Nuxt、SvelteKit、Astro SSR、React Router、Cloudflare Workers等では、同じサーバー境界を既存のroute・loader・actionへ合わせて実装します。

静的SPAだけでは限定コンテンツを保護できません。信頼できるサーバー、serverless function、またはWorkerが必要です。

## Next.jsの導入例

[`examples/nextjs`](examples/nextjs) は買い切り1商品・`/members` 1ページの実装例です（Next.js 16）。各境界で独立に認可します。

`@nulogic/cozeni-sdk/next`（Next.js 15・16専用のサブパスexport。`next` をpeerDependencyとして要求、任意）が、`cozeni_code` の交換から、`enter_url` への自動リダイレクトと無限リダイレクトの停止までを行います。**このサブパスはNext.jsのバンドラ（webpack/turbopack）を通してのみ動作します。** root export（`@nulogic/cozeni-sdk` 本体）とCLIは素のNode ESMだけで動作し、この制約を持ちません。

```ts
// proxy.ts（Next.js 16。15では middleware.ts で `cozeniProxy as middleware`）
export { cozeniProxy as proxy } from "@nulogic/cozeni-sdk/next";
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

```tsx
// 保護ページ
import { AccessDenied, requireEntitlement } from "@nulogic/cozeni-sdk/next";

export default async function Page() {
  try {
    await requireEntitlement("prd_..."); // 権利が無ければenter_urlへredirect()
  } catch (error) {
    if (!(error instanceof AccessDenied)) throw error; // redirect()は投げ直す
    return <p>表示できません</p>;
  }
  // ...保護コンテンツ
}
```

```tsx
// 購入ボタン（CLIが返した購入リンク）
<a href="https://app.cozeni.net/checkout/...">購入する</a>
```

| API | 振る舞い |
|---|---|
| `cozeniProxy(request)` | `?cozeni_code` 付きのGETでコードを交換し、`cozeni_customer` を設定して、コードを除いた同じURLへ303で戻す。結果は1回だけ有効な `cozeni_handoff` Cookie（`ok` / `invalid_code` / `unavailable`、60秒）で伝え、次のリクエストではページへ通したうえで応答で消す |
| `handleCozeniHandoff(request, options?)` / `clearCozeniHandoff(request, response)` | 既存のmiddleware / proxyと組み合わせる用。前者はコードの交換だけを行い `Response \| undefined` を返す。後者は既存の応答に印の消去を足す |
| `requireEntitlement(productId)` | page専用。権利が無ければ `enter_url` へリダイレクトする。`cozeni_handoff` の印があればリダイレクトせず `AccessDenied` を投げる（印が `unavailable` なら理由も `unavailable`） |
| `entitlement(productId)` / `denialResponse(result, productId)` | Route Handler・Server Action用。リダイレクトしない |

戻り先のオリジンは `COZENI_SITE_ORIGIN` に固定し、`Host` ヘッダーを信用しません。**サイトは1つのオリジンで公開してください**（例：`www` の有無をリダイレクトで統一する）。`COZENI_SITE_ORIGIN` と違うホストでアクセスされた場合もコードの交換は行われますが、購入者のCookieはアクセスされたホストに付き、戻り先の `COZENI_SITE_ORIGIN` には届きません。単回のコードは消費されるため、購入者はメールアドレスでの再入場が必要になります。**本番で必要な環境変数は `COZENI_SITE_ORIGIN` だけです。** APIオリジンの既定値は `https://api.cozeni.net` で、Cozeniを手元で動かす開発時だけ `COZENI_API_ORIGIN` で上書きします。商品IDと購入リンクは秘密ではないので、コードに直接書きます。

**リダイレクトするのはpageの入口だけです。** `requireEntitlement()` はnext/navigationの `redirect()`（制御フロー例外）を投げることがあります。呼び出しは `AccessDenied` だけを捕捉し、それ以外はcatchで握りつぶさず上位へ伝播させてください。**Route Handler（JSON API）**は `entitlement()` の結果を `denialResponse()` へ渡し、401/403/503のJSONへ `enter_url` を含めます。**Server Action**はWeb Responseを返さず、`entitlement()` の結果の理由をplain objectとして返します。

| 境界 | 実装 |
|---|---|
| ハンドオフ | `proxy.ts` |
| ページ / HTML / RSC | `app/members/page.tsx`（`requireEntitlement`） |
| Route Handler | `app/api/protected/route.ts`（401 / 403 / 503とenter_urlをJSONで返す） |
| Server Action | `app/members/actions.ts` |
| 購入ボタン | `app/page.tsx` |

起動は `examples/nextjs` で `bun run dev`。`.env.example` のとおり `COZENI_SITE_ORIGIN` を設定します。ハンドオフURLの `cozeni_code` はアクセスログに残さないでください。

Next.js 15のmiddlewareは、リダイレクト先のループバックのホスト名（`127.0.0.1`）を `localhost` に書き換えます。Next.js 15のローカル開発では、`COZENI_SITE_ORIGIN` とブラウザで開くURLを `localhost` に揃えてください（ホスト単位の購入者Cookieが届かなくなるため）。実在のドメインでは起きません。

### 0.3系からの移行

0.3系の書き方（`COZENI_PRODUCT_ID` などの環境変数、`requireEntitlement({ apiOrigin, productId, haltRedirect })`、`nextEntitlement()`、handoffのRoute Handler）はそのまま動きます。移行は必須ではありません。移行する場合は、handoffとCookie消去のルート、ページ内の `cozeni_code` の転送と印の処理を削除し、上の `proxy.ts` と `requireEntitlement(productId)` に置き換えます。0.3系で使っていた商品登録helper（`skills/cozeni-setup/scripts/`）と `.cozeni/` の状態ファイルはCLIに置き換わりました。

## 開発

```sh
bun install --frozen-lockfile
bun run setup:hooks
bun run check
```

開発用フックは `bun run setup:hooks` で `core.hooksPath` を `.githooks` に設定します。以後コミット前に `format:check` / `lint` / `typecheck` / `test` が走ります。整形とlintの自動修正は `bun run format`、迂回は `git commit --no-verify` です。[CI](.github/workflows/ci.yml) はmainへのpushとpull requestでSDKと導入例のビルドを検証します。

`bun run test:next-runtime` は `check` に含みます（`check` では直前に `build` が走ります）。現在の `dist` をnpm packしたtarball（`scripts/example-consumer.mjs`）で一時consumerを作り、Next.js 16（`proxy.ts`）と15（`middleware.ts`）のそれぞれで `bun install` / `next build` / `next start` まで行います。単独で実行するときは、先に `bun run build` を実行してください（packは `--ignore-scripts` のため、古い `dist` のまま検証してしまいます）。ローカルのCozeni API互換モックを起動し、実際に起動した本番相当サーバーへHTTPで到達して、ハンドオフの交換とコード除去、印の設定と消去、外部enter_urlへのリダイレクトと停止条件、Route Handlerが実際にリダイレクトしないことを確認します。Server Actionの非リダイレクト・plain object返却はNext.jsのAction ID解決が実HTTPでは複雑なため、vitestのユニットテスト（`examples/nextjs/tests/security.test.ts`）側で検証します。

CLIのテスト（`tests/cli.test.ts`・`tests/cli-store.test.ts`）は、通信をモックし、一時ディレクトリを `XDG_CONFIG_HOME` にして、保存ファイルの権限と置き換えを含めて検証します。
