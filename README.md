# @nulogic/cozeni-sdk

Cozeni外部API v1用のサーバー向けJavaScript / TypeScript SDKです。Node.js 20以降、標準fetchを持つサーバー環境で動作します。Next.jsには依存しません。公開npmレジストリで配布しています。

| | 用途 | 管理キー |
|---|---|---|
| 管理API | 商品の作成・更新・取得、購入リンクの発行 | 必要 |
| 購入者API | Cookieから購入権限を判定し、保護コンテンツの表示可否を決める | 不要 |
| ハンドオフ | Cozeniの単回コードを自サイトのCookieへ交換 | 不要 |

## インストール

対象サイトがすでに使用しているpackage managerで依存へ追加します。**取得に認証は必要ありません。**

```sh
npm install @nulogic/cozeni-sdk
# または: bun add / pnpm add / yarn add @nulogic/cozeni-sdk
```

install後、Cozeni導入プロンプト（下記）とともに、コーディングAIへ「`node_modules/@nulogic/cozeni-sdk/skills/cozeni-setup/SKILL.md` を読み、採用中のフレームワークに合う実装資料に従う」と指示します。

## Cozeni導入プロンプトとは

このSDKに同梱される skill（`skills/cozeni-setup/`）は「フレームワークへの組み込み方」だけを扱います。
接続先・商品・購入リンク・秘密の扱い・検証手順といった**アカウント固有の値と共通契約は、導入プロンプトが定めます。**

導入プロンプトは Cozeni の管理画面（**設定 → 開発者**）で、クリエイターごとに生成してコピーします。
販売者本人のAPI origin・商品ID・購入リンクが埋め込まれるため、このリポジトリには同梱できません。

| | 出どころ |
|---|---|
| フレームワーク実装の手順 | このpackageの `skills/cozeni-setup/` |
| 接続先・商品・購入リンク | Cozeni管理画面が生成する導入プロンプト |
| APIキー | Cozeni管理画面で個別に発行（プロンプトには含まれません） |

導入プロンプトを使わず、下記のAPIリファレンスだけを見て自分で実装することもできます。
その場合も `examples/` の実装が完全な参照になります。

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
}
```

`cozeni_customer` Cookieだけを読み、既存の認証CookieはCozeniへ転送しません。未認証・無効応答・通信障害・タイムアウトのいずれでも許可せず、`unavailable`（Cozeni側の障害）を購入要求へ変換しないでください。

`exchangeHandoff(code)` は60秒・単回のコードを `{token}` へ交換します。結果は `customerCookie` で自サイトのHttpOnly Cookieへ保存します。信頼originはサーバー設定から指定し、Hostヘッダーから組み立てません。

両clientに `fetch` と `timeoutMs`（既定10秒）を注入できます。エラーは `CozeniError`（`code` / `status` / `requestId` / `retryAfterSeconds`）で、秘密や生の応答を保持しません。

## JavaScript / TypeScriptサーバーの導入例

[`examples/javascript-server`](examples/javascript-server) に、Web標準 `Request` / `Response` の保護ハンドラーとNode.js HTTP接続例があります。Express、Fastify、Hono、Nuxt、SvelteKit、Astro SSR、React Router、Cloudflare Workers等では、同じサーバー境界を既存のroute・loader・actionへ合わせて実装します。

静的SPAだけでは限定コンテンツを保護できません。信頼できるサーバー、serverless function、またはWorkerが必要です。

## Next.jsの導入例

[`examples/nextjs`](examples/nextjs) は買い切り1商品・`/members` 1ページの実装例です。各境界で独立に認可します。

| 境界 | 実装 |
|---|---|
| ページ / HTML / RSC | `app/members/page.tsx` |
| 保護データ取得 | `lib/cozeni.ts` の `protectedData` |
| Route Handler | `/api/protected`（401 / 403 / 503を区別） |
| Server Action | `protectedAction` |
| ハンドオフ | `/cozeni/handoff` |
| Cookie消去 | `POST /cozeni/clear` |

設定は `.env.example` に従います。導入プロンプトが実行する商品登録helperは、保存済み応答から商品IDとリンクを設定します。商品登録helperはmacOS / Linux専用です（SDK本体に制限はありません）。

起動は `examples/nextjs` で `bun run dev`。Cozeniをlocalhost、購入者サイトを127.0.0.1にしてCookieをホスト単位で分離します。ハンドオフURLの `cozeni_code` はアクセスログに残さないでください。

## 開発

```sh
bun install --frozen-lockfile
bun run setup:hooks
bun run check

# 導入例は公開npmのSDKを参照する
cd examples/nextjs && bun install && bun run build && cd ../..
bun run test:next-runtime
```

開発用フックは `bun run setup:hooks` で `core.hooksPath` を `.githooks` に設定します。以後コミット前に `format:check` / `lint` / `typecheck` / `test` が走ります。整形とlintの自動修正は `bun run format`、迂回は `git commit --no-verify` です。[CI](.github/workflows/ci.yml) はmainへのpushとpull requestでSDKと導入例のビルドを検証します。
