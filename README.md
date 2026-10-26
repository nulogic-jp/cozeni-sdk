# @nulogic/cozeni-sdk

Cozeni外部API v1用のサーバー向けJavaScript / TypeScript SDKと、商品や販売状態を操作するCLIです。Node.js 20以降、標準fetchを持つサーバー環境で動作します。SDK本体はNext.jsに依存しません。公開npmレジストリで配布しています。

| | 用途 | 管理キー |
|---|---|---|
| CLI（`npx cozeni`） | ログイン、商品の作成・更新、購入リンクの取得、販売状態の確認 | ログインで取得（手元にだけ保存） |
| 管理API | 商品の作成・更新・取得、商品画像の設定・削除、購入リンクの発行 | 必要 |
| 機能フラグ | 購入画面の作成、購入者の機能フラグの照会（サーバーだけで使う） | 必要（`checkouts:write`・`customers:read`） |
| 購入者API | Cookieから購入権限を判定し、保護コンテンツの表示可否を決める | 不要 |
| ハンドオフ | Cozeniの単回コードを自サイトのCookieへ交換 | 不要 |
| `@nulogic/cozeni-sdk/next` | Next.js 15・16でのハンドオフ・認可・リダイレクト、機能フラグの3関数 | ハンドオフ・認可は不要、機能フラグの3関数は必要 |

**購入者限定ページのサイトは管理キーを使いません。** 管理操作は手元のCLIで行い、サイトには購入者API（キー不要）だけを組み込みます。**機能フラグを使うサイトだけは、サーバーの環境変数に専用のキーを置きます**（下の「機能フラグ」）。

## インストール

サイトのプロジェクトのフォルダで `init` を実行します。**取得に認証は必要ありません。**

```sh
npx @nulogic/cozeni-sdk@0.8.0 init --creator <クリエイターID>
```

`--profile` を付けない `init` は、サンドボックスで実装・テスト購入してから本番へ切り替える流れの準備です（下の「サンドボックス」）。サンドボックスを使わず本番に直接つなぐときは `--profile production` を付けます。

`init` は次を行います（通信するのは package manager だけです）。

1. 実行した場所から上へたどって `package.json` のある場所をプロジェクトのルートにする。
2. `package.json` の `packageManager`（例 `pnpm@9.1.0`）、無ければ lockfile（`bun.lock`・`bun.lockb` → bun、`pnpm-lock.yaml` → pnpm、`yarn.lock` → yarn、`package-lock.json` か無し → npm）で package manager を決め、`@nulogic/cozeni-sdk@<実行した版>` を厳密な版で通常の依存として入れる。同じ版が依存に入っていれば入れ直さない。ワークスペースでは、リポジトリの端（`.git` のある場所）まで上位を探す。`packageManager` と lockfile が食い違えば選ばずに `package_manager_conflict` で止まる。
3. 同梱のskill（[`skills/cozeni-setup/`](skills/cozeni-setup/SKILL.md)）を `.agents/skills/cozeni-setup` にコピーする。Claude Code の実行環境（`CLAUDECODE`）か、プロジェクトに `.claude/` があれば `.claude/skills/cozeni-setup` にもコピーする。シンボリックリンクは使わず、既存のものはこの版のskillで置き換える（同じ中身なら何もしない）。途中の `.agents`・`.agents/skills`・`.claude`・`.claude/skills` がシンボリックリンクだったり、実体がプロジェクトの外にあったりすれば、書き込まずに `unsafe_path` で止まる。
4. 接続先（プロファイル）と、そのプロファイルで使うクリエイターを設定ファイルに覚える（下の「既定のプロファイル」）。**`--profile` を付けずに `--creator` を渡すと、本番の管理画面の導入プロンプトの形として、本番のクリエイターIDを `production` の期待値に保存し、既定のプロファイルを `sandbox` にする**（サンドボックスではクリエイターを照合しない）。`--profile production` を付けると、サンドボックスを使わず本番に直接つなぐ。`--profile` も `--creator` も省略した再実行では、今の既定のプロファイルを引き継ぐ。保存済みのプロファイルは `--profile` だけで再初期化でき、接続先を指定し直す必要はない。

package manager の出力は表示しません（認証情報を含みうるため）。失敗したら、実行したコマンド（`error.command`）と終了コード（`error.exit_code`）を `install_failed` で返すので、同じコマンドを手で実行して原因を確かめてください。手で入れる場合は `npm install @nulogic/cozeni-sdk`（または `bun add` / `pnpm add` / `yarn add`）です。

skillは、いつどのCLIを呼ぶか、コードのどこに何を書くか、どう確かめて報告するかをAIに伝えます。追加されたskillはプロジェクトと一緒にcommitしてください。**`cozeni-setup` のフォルダは `init` が管理し、更新時に丸ごと置き換えます。手で編集せず、プロジェクト独自の手順は `AGENTS.md` などに書いてください。**frontmatterの `metadata.cozeni-sdk-version` に対応するSDKの版の範囲があり、CLIは起動時にこれを照合して、ずれていれば `init` での更新を促します。

Cozeniの管理画面（**設定 → 開発者**）の導入プロンプトは、この `init` を最初の1コマンドとしてAIに渡します。以後AIは、CLIの出力（`next_step`・`error.hint`）とskillに従って進みます。導入プロンプトを使わず、以下のリファレンスだけを見て自分で実装することもできます。その場合も `examples/` の実装が完全な参照になります。

## サンドボックス

本番とは別のアカウント・データで、実際の請求なしに導入を試せる環境です。Stripeはテストモードで動き、テストカードで購入できます。本番のアカウント・キー・商品はサンドボックスでは使えません（逆も同じです）。

| | 本番（既定） | サンドボックス |
|---|---|---|
| CLI | 指定なし（`production` プロファイル） | `--profile sandbox` |
| SDK（サイト） | 指定なし | 環境変数 `COZENI_ENVIRONMENT=sandbox` |
| API | `https://api.cozeni.net` | `https://api-sandbox.cozeni.net` |
| 管理画面 | `https://cozeni.net` | `https://sandbox.cozeni.net` |
| 購入リンク | `https://checkout.cozeni.net` | `https://checkout-sandbox.cozeni.net` |
| APIキー | `cozeni_sk_` + 64桁 | `cozeni_sk_sandbox_` + 64桁 |

- 本番の管理画面の導入プロンプトの `init --creator <本番のクリエイターID>`（`--profile` なし）は、既定のプロファイルを `sandbox` にし、本番のIDを `production` の期待値として保存します。サンドボックスのログインではクリエイターを照合せず、本番に切り替えるときのログインで照合します（別のアカウントなら `creator_mismatch`）。以後のCLIは指定なしでサンドボックスにつながります。ログインもサンドボックスのアカウントで別に行います。
- サンドボックスの管理画面の導入プロンプト（`init --profile sandbox --creator <サンドボックスのクリエイターID>`）は、サンドボックスのクリエイターIDで照合し、導入の流れを `sandbox-only` として保存します。本番への切り替え（自動・`switch`・案内）は行いません（過去の本番の期待値が残っていても同じです）。
- サンドボックスを使わず本番に直接つなぐときは、`init --creator <本番のクリエイターID> --profile production` を使います（テスト購入はできません）。
- CLIは、サンドボックスのキーを本番へ、本番のキーをサンドボックスへ送ろうとすると、送らずに `environment_mismatch` で止まります（`COZENI_API_KEY` も同じです）。
- `COZENI_ENVIRONMENT` は `production` か `sandbox` だけを受け付けます。ほかの値や、`COZENI_API_ORIGIN` が別の環境を指しているときは問い合わせず、購入者には `unavailable` として扱い、理由をサーバーのログに出します。開発サーバー（`NODE_ENV` が `production` 以外）では、最初の問い合わせで接続先の環境名をログに出します。

### テスト購入

`npx cozeni test-purchase --product <商品ID> --site-origin <開発サーバーのURL> --json` は、サンドボックスでだけ動きます。サーバーがテストカードで決済を確定させ、CLI が限定ページに入れることを確かめて返金します。

1. `production` プロファイル、または `localhost`・`127.0.0.1`・`[::1]` 以外の `--site-origin` では、何も送らずに止まります（`test_purchase_unavailable`・`site_origin_not_allowed`、終了コード2）。サーバーも本番では受け付けません。
2. 購入権ができるまで、`login --complete` と同じ間隔（5秒）で打ち直し、最長90秒待ちます。間に合わなければ終了コード6（`authorization_pending`）で、同じコマンドを打ち直します（処理中の決済があれば新たに決済しません）。
3. サーバーが返すワンタイムコードは**出力しません**。商品の限定ページ（`access_url` のパス）を `--site-origin` 上で `?cozeni_code=` 付きで要求し、303で戻ったページへ Cookie を付けて入れること、続けて Cookie なしで同じページを要求して Cozeni の入場画面（`enter_url`）へ送られることを確かめます。
4. 確かめたら返金します。入場の確認に失敗したときは返金せず（`entry_check_failed`、終了コード4）、直して打ち直せば、既存の購入権を確かめてから返金します。
5. 売上の受け取り先の登録が済んでいないとき（409 `creator_not_ready`）は、`error.hint` に登録の依頼と待ち方を示します。

```json
{"ok":true,"data":{"profile":"sandbox","product_id":"prd_…","site_origin":"http://localhost:3000","entered":true,"redirected_when_unpurchased":true,"refunded":true,"refund_count":1,"next_step":"利用者への1通の案内（AIへの指示）"}}
```

### 本番へ切り替える

テスト購入が通ったら、利用者に「サンドボックスで確認できたので、本番を導入してよいですか？」と尋ね、許可を得てから本番にログインします（`npx cozeni login --profile production`）。

- 承認が完了し、期待するクリエイターと一致したら、`login --complete --profile production` が既定のプロファイルを `production` に書き換えます（`data.switched_to_production: true`）。以後のCLIは指定なしで本番につながります。
- 本番にログイン済みで一致していれば、承認は求めません。`login` の `next_step` が、利用者に「切り替えてよいか」を聞くよう案内します。返事を得たら `npx cozeni switch` を実行します。
- 切り替えたら、本番で同じ内容の商品を作り直し（`npx cozeni products create`。同じ内容があれば作らずに返す）、コード中の商品IDと購入リンクを本番のものに差し替え、サイトの環境変数から `COZENI_ENVIRONMENT` を外します。

サンドボックスの商品IDが本番のコードに残っていても、本番では権利が無い（`no_grant`）として扱われるだけで、エラーにはなりません。差し替え漏れは `npx cozeni products get <商品ID>` で確かめてください。

## CLI

```sh
npx cozeni <コマンド> [--json] [--profile <名前>] [--yes]
```

`init` 以外のコマンドは、SDKをプロジェクトの依存に入れてから **`npx cozeni`** で呼びます。npxはプロジェクトに入っている `cozeni` を実行します。SDKが入っていないディレクトリでは、npm の `cozeni`（Nulogicが保持する予約パッケージ。CLIは含まない）を取得し、「Cozeni の SDK がこのプロジェクトに入っていません。」と出して終了コード1で止まります。止まったら、サイトのプロジェクトのフォルダで依存を入れ直すか、`init` を実行してください。

`init` はSDKを入れる前に実行するので、スコープ付きの `npx @nulogic/cozeni-sdk@<版> init` で呼びます。

| コマンド | 役割 |
|---|---|
| `init --creator <クリエイターID>` | 導入の準備。SDKを依存に追加し、skillを置き、接続先と使うクリエイターを覚える |
| `login` | ログインを始める。承認用のURLとコードを表示する（ログイン済みなら何もしない） |
| `login --complete` | 承認を確かめ、キーを保存する |
| `logout` | サーバー側でキーを失効させ、手元の認証情報を消す |
| `whoami` | 接続先の環境・クリエイター・キーの期限を表示 |
| `status` | 販売できる状態か（`sales`）、次にやること（`next_actions`）、商品一覧、キーの期限 |
| `products list` | 商品一覧 |
| `products get <商品ID>` | 商品1件と購入リンクの状態（取得だけで、リンクを発行しない） |
| `products create --name <名前> --price <円> --access-url <URL>` | 商品を作成し、標準の購入リンクを返す。同じ内容の有効な商品があれば作らずにそれを返す（`--allow-duplicate` で作る） |
| `products update <商品ID> [--name] [--price] [--access-url]` | 商品を変更する |
| `link <商品ID>` | 標準の購入リンクを取得する（無ければ発行） |
| `test-purchase --product <商品ID> --site-origin <URL>` | サンドボックス専用。テスト購入して限定ページに入れることを確かめ、返金する（上の「テスト購入」） |
| `switch` | 本番にログイン済みで期待するクリエイターと一致していれば、既定のプロファイルを `production` にする（上の「本番へ切り替える」） |

### ログイン

デバイスコード方式（RFC 8628）です。利用者はブラウザで表示されたコードを確かめて「許可」を押すだけで、キーを手で受け渡しません。

AIエージェントのシェルはコマンドが終わるまで出力を返さないことが多いため、非対話では2段階で動きます。

1. `login` はコードを発行してすぐ終了します（期限内に再実行すると同じコードを出し直します）。
2. 利用者が承認したら、`login --complete` が最長90秒ポーリングしてキーを保存します。承認前なら終了コード6で戻るので、同じコマンドを打ち直します。

TTYがあり、AIエージェントの実行環境（`CLAUDECODE`・`CURSOR_AGENT`・`CODEX_*` などの環境変数）やCIでなければ、1段階でコードを表示して承認を待ちます（Enterでブラウザを開きます）。

保存済みのキーが有効（`GET /account` が成功）で、期待するクリエイターと一致し、期限まで7日以上あれば、`login` は何もせずに成功します（`data.already_logged_in: true`）。導入の手順を最初からやり直しても、承認を求め直しません。

`login --complete` で得たキーのクリエイターが期待と違う（ブラウザで別のアカウントにログインしたまま承認した）場合は、そのキーを保存せずにサーバーでも失効させ、`creator_mismatch` で止まります。

ログインで得るキーは商品と購入リンクの操作に限られ、**発行から30日で失効します**（使っても延長されません）。ログインし直すと、新しいキーを保存したあとで前のキーを失効させます。

### 既定のプロファイルとクリエイターの照合

`init` は `$XDG_CONFIG_HOME/cozeni/config.json` に、既定のプロファイル（`default_profile`）と、プロファイルごとの期待するクリエイター（`expected_creator_id`）を保存します。秘密は含みません。

- `--profile` を省略すると、`default_profile`（無ければ `production`）を使います。`init` は `--profile` も `--creator` も省略した再実行では今の既定を引き継ぎ、`--creator` だけなら本番の管理画面のプロンプトの形（既定を `sandbox` にする）になります。
- `production`（本番）と `sandbox`（サンドボックス）の接続先は固定で、`--api-origin`・`--app-origin`・`COZENI_API_ORIGIN` での変更を受け付けません。ログインでサーバーが返す環境がプロファイル名と違えば、キーを保存しません。それ以外のプロファイルは、`init` で `--api-origin` と `--app-origin` を必須にし、プロファイルと一緒に保存します。以後のコマンドでは省略できます（指定 → `COZENI_API_ORIGIN` → 保存した値の順）。保存済みのキーは、発行されたオリジンにしか送りません。
- 期待するクリエイターがあるプロファイルでは、使うキーのクリエイター（保存したキーなら保存値、`COZENI_API_KEY` なら `GET /account` の結果）が違えば、変更系の要求を送る前に `creator_mismatch` で止まります。

### 出力と終了コード

`--json` を付けると、1行のJSONを標準出力に出します。秘密（APIキー）はどの出力にも含めません。主要なコマンド（`init`・`login`・`status`・`products get`・`products create`）の `data.next_step` は次に打つコマンドです（無ければ `null`）。`status` の `data.message_for_user` は、利用者にそのまま見せられる日本語の「次にやること」の行です（販売できるなら「すぐ販売できます。」）。

```json
{"ok":true,"data":{}}
{"ok":false,"error":{"code":"login_required","message":"…","hint":"npx cozeni login を実行してください。"}}
```

| 終了コード | 意味 | 代表的な `error.code` |
|---|---|---|
| 0 | 成功 | — |
| 1 | 想定外のエラー | `internal`・`invalid_response`・`insecure_storage`・`invalid_state`・`install_failed`・`package_manager_conflict`・`unsafe_path` |
| 2 | 使い方の誤り・確認が必要 | `invalid_input`・`confirmation_required`・`origin_mismatch`・`environment_mismatch`・`test_purchase_unavailable`・`site_origin_not_allowed` |
| 3 | ログインが必要 | `login_required`・`key_expired`・`access_denied`・`expired_token` |
| 4 | 権限・規約・状態で拒否 | `terms_consent_required`・`forbidden`・`not_found`・`product_archived`・`idempotency_conflict`・`creator_mismatch`・`creator_not_ready`・`entry_check_failed` |
| 5 | 通信できない・一時障害 | `network_unreachable`・`unexpected_redirect`・`rate_limited`・`unavailable`・`stripe_error`・`site_unreachable` |
| 6 | 承認待ち | `authorization_pending` |

通信できないときは、Codex cloud や Claude Code on the web などクラウドで動くツール向けに、`api.cozeni.net` への通信を許可する手順を `hint` に示します。429では `retry_after_seconds` を返します。

### 確認が必要な操作

商品の作成、価格の変更、`access_url`（購入後に表示するページ）の変更は、`--yes` が無ければ実行しません。`access_url` の変更は既存の購入者全員にすぐ反映されるためです。TTYでは変更前後を示して確認を求め、TTYが無ければ `confirmation_required` で止まります（確認する内容は `error.details`）。AIは利用者に確認してから `--yes` を付けて実行します。

`products create` は、作成の前に商品一覧を見て、名前・価格・`access_url` が同じ有効な商品があれば、作らずにそれを返します（`data.reused: true`、`data.reason: "same_product_exists"`。確認は不要です）。そのとき購入リンクは取得だけで、未発行なら発行せず `data.next_step` に `link` を返します。同じ内容でも別の商品を作るには `--allow-duplicate` を付けます。

さらに、入力ごとに冪等キーを保存してから送信します。タイムアウトなどで結果が分からないときは、同じコマンドをそのまま再実行すれば、商品が二重に作られません。冪等キーは成功後も24時間残し、その間に同じ入力で再実行すると、作成済みの商品を返します（`data.reused: true`、`data.reason: "idempotent_retry"`。`--allow-duplicate` のときは作成済みのキーを使い回しません）。24時間を過ぎたキーはCLIの起動時に消します。価格は50円から9,999,999円までの整数です。

### 認証情報の保存先

`$XDG_CONFIG_HOME/cozeni/`（未設定なら `~/.config/cozeni/`）に保存します。プロジェクトの中には置きません。

- `credentials.json`：プロファイルごとのキーと接続先。平文ですが、ディレクトリ0700・ファイル0600で書きます。
- `config.json`：既定のプロファイルと、プロファイルごとの期待するクリエイター・接続先（`init` が書く）。秘密は含みませんが、同じ権限で書きます。
- `pending/`：ログインの待ち状態と、未完了の冪等キー。
- 書き込みは一時ファイルを経由して置き換えます。シンボリックリンクや、所有者以外が読める権限のファイルを見つけたら、読み書きせずに止まります。

**Windowsではファイル権限の検査を行いません**（権限ビットで所有者だけに絞れないため）。Windowsでは `XDG_CONFIG_HOME` を共有フォルダや同期フォルダに向けないでください。

キーは発行された接続先にだけ送ります。`production`（既定）の接続先は `https://api.cozeni.net` と `https://cozeni.net`、`sandbox` は `https://api-sandbox.cozeni.net` と `https://sandbox.cozeni.net` に固定です。キーを付けた要求はリダイレクトを追いません。

環境変数 `COZENI_API_KEY` があれば、保存したキーより優先して使います（CIなど向け）。`logout` はこのキーを失効させません。

## 管理API

```ts
import {readFile} from 'node:fs/promises';
import {createManagementClient} from '@nulogic/cozeni-sdk';

const client = createManagementClient({
  apiOrigin: process.env.COZENI_API_ORIGIN!,
  apiKey: process.env.COZENI_API_KEY!,
});

const product = await client.products.create(
  {
    name: '商品名',
    price_jpy: 1000,
    access_url: 'https://example.com/members',
    description: '## 内容\n\n- 全40ページのPDF', // 任意。Markdown
  },
  {idempotencyKey: '保存済みの冪等キー'},
);
const link = await client.checkoutLinks.get(product.id);

// 商品画像（Blob / File）。応答は更新後の商品（images に入る）
const image = new Blob([await readFile('./cover.png')], {type: 'image/png'});
const withImage = await client.products.putImage(product.id, image);
const withoutImage = await client.products.deleteImage(product.id);
```

ほかに `account.get`、`products.list` / `get` / `update`、`checkoutLinks.ensure` があります。商品の種類は `access_type`（`'page'` 購入者限定ページ・`'feature'` 機能フラグ）で、作成で省略すると `'page'` です。`'feature'` の商品は `access_url` を持たず、`metadata`（設定値）を持てます。応答の `access_url` は、URLを持たない商品（`feature`・`file`）では `null` です。商品の種類の判定には `access_url` ではなく `access_type` を使います。`access_type` は作成後に変えられず、更新の `metadata` は全置換です（`{}` で全消去、省略で変更なし）。`price_jpy` は円をそのまま渡します。`create` の冪等キーはPOSTより前に保存し、応答を失っても同じ入力・同じキーで再送します（自動リトライはありません）。

`description` は商品の説明（Markdown）で、`create` / `update` に任意で渡します。前後の空白を除いて4000コードポイントまでで、`null`・空白だけなら説明なしです。商品の `description` は文字列か `null` で、長さはSDKでは検証せずサーバーの判定（`invalid_input`）に任せます。

商品画像は `products.putImage(productId, file)`（`PUT /products/{product_id}/image`、`externalPutProductImage`）で設定し、`products.deleteImage(productId)`（`DELETE /products/{product_id}/image`、`externalDeleteProductImage`）で外します。どちらも更新後の商品を返し、`images` に `id` / `url` / `content_type` / `size_bytes` が入ります。

- `file` は `Blob`（`File` も可）で、`multipart/form-data` の `file` 欄に1枚送ります。`Blob` でなければ `invalid_input` を投げてAPIを呼びません。
- 形式はJPEG・PNG・WebPで、5MB（5,242,880バイト）までです。形式は申告された `Content-Type` ではなく中身で判定します。SDKでは事前に検査せず、サーバーの `image_too_large`（413）・`unsupported_image_type`（415）を `CozeniError` のまま返します。
- 画像は1枚だけです。`putImage` は既存の画像を差し替え、URL（`images[].url`）が変わります。画像のURLを控えている場合は、差し替えのたびに応答から取り直してください。
- `deleteImage` は画像が無くても200で商品を返します。
- 大きい画像のアップロードは10秒（`timeoutMs` の既定）で `timeout` になることがあります。必要なら `createManagementClient` の `timeoutMs` を延ばします（上限は120秒）。

管理キーはサーバー環境変数のみに置き、ブラウザや `NEXT_PUBLIC_*` へ渡しません。

## 機能フラグ（購入画面の作成・購入者の照会）

販売者のアプリのログインユーザーに、機能フラグの商品（`access_type: 'feature'`）を買わせ、買ったかどうか・設定値を照会します。使う関数は `createCheckout`（購入画面を作る）・`getCustomerState`（付与済みの機能フラグをすべて返す）・`hasFeatureFlag`（特定の商品だけ確かめる）の3つです。

| 使う場所 | 呼び方 |
|---|---|
| Next.js（15・16） | `@nulogic/cozeni-sdk/next` の3関数。キーと接続先を環境変数から読む |
| それ以外のサーバー | `createManagementClient` の戻り値の同名のメソッド |

以降の例は `/next` の関数名で書きます。それ以外のサーバーでは `cozeni.createCheckout(...)` のように読み替えます。

### キーと環境変数

管理画面の開発者設定でAPIキーを発行します。スコープは `checkouts:write`（購入画面を作る）と `customers:read`（購入者の機能フラグを確かめる）です。CLIのキーや導入用のプリセットには含まれず、CLIはこのキーを発行も保存もしません。

- キーは**サーバーの環境変数 `COZENI_API_KEY` だけ**に置き、ブラウザ・リポジトリ・ログへ出しません。`NEXT_PUBLIC_*` に入れてはいけません。
- サンドボックスのキー（`cozeni_sk_sandbox_` で始まる）は、**`COZENI_ENVIRONMENT=sandbox` と組**にします。ローカルの `.env`（Next.jsは `.env.local`）に置きます。本番のキーは本番の環境変数に置きます。サンドボックスのキーは本番の接続先では使えません（逆も同じです。上の「サンドボックス」）。

```sh
# .env.local（サンドボックス。.gitignore に入れる）
COZENI_API_KEY=cozeni_sk_sandbox_…
COZENI_ENVIRONMENT=sandbox
```

`/next` の3関数は、設定が足りないときに `CozeniError`（`code: 'invalid_input'`）を投げ、値を含まない理由をサーバーのログに1回出します。`COZENI_API_KEY` が空・未設定のとき、`NEXT_PUBLIC_COZENI_API_KEY` が設定されているとき（値が空でも。ブラウザに渡るキーなので使いません。消して失効させ、`COZENI_API_KEY` に設定し直します）、`COZENI_ENVIRONMENT` や `COZENI_API_ORIGIN` が不正なときです。

それ以外のサーバーでは、同じ環境変数から作ります。

```ts
import {createManagementClient, type Environment} from '@nulogic/cozeni-sdk';

// サーバー専用。
const cozeni = createManagementClient({
  apiKey: process.env.COZENI_API_KEY!,
  // 'production'・'sandbox'、未指定（本番）。それ以外の値は渡さない
  environment: (process.env.COZENI_ENVIRONMENT?.trim() || undefined) as
    | Environment
    | undefined,
});
```

`COZENI_API_KEY!` は型の指定だけで、未設定の確認はしません。未設定のままでは、`/next` の3関数と違って理由のログは出ず、クライアントを作る時点（モジュールの読み込み時）に `CozeniError`（`code: 'invalid_input'`）を投げます。CLIも同じ環境変数名 `COZENI_API_KEY` を読む（保存したキーより優先）ので、アプリ用のキーを入れたシェルでCLIを使うと、CLIがそのキーを使います。アプリ用のキーを、CLIを動かすシェルへ書き出さないでください。

### 前提（必ず読む）

- **ログインのメールアドレスの本人確認を、アプリ側で済ませておく。** Cozeniの購入画面のメールアドレスは確認していません。未確認のメールアドレスでアカウントを作れると、他人の購入を自分のアカウントで使えてしまいます。ログインが無い、またはメールアドレスの本人確認が無いサイトでは、機能フラグを使わず購入者限定ページにします。
- **判定と上限の管理はサーバーで行う。** 画面で隠すだけにせず、機能のAPI（Route Handler・Server Action）でも照会します。
- 設定値（`metadata`）はアプリのサーバーだけが受け取ります。ただし管理画面とAPIの応答に平文で出るので、APIキーなどの秘密の置き場にはしません。
- 機能フラグの商品は `access_url` を持ちません（応答では `null`）。商品の種類は `access_type` で判定します。

### 購入画面を作る

ログイン中のユーザーのメールアドレスで購入試行を作り、購入画面のURLを返します。購入画面ではメールアドレスを変更できないため、照会するメールアドレスとの食い違いを防げます。

```ts
import {createCheckout} from '@nulogic/cozeni-sdk/next';
import {redirect} from 'next/navigation';

// Server Action または Route Handler
const checkout = await createCheckout({
  productId: process.env.COZENI_PRO_PRODUCT_ID!,
  email: session.user.email, // ログイン中のユーザーのメールアドレス
});
redirect(checkout.url); // checkout.expiresAt（作成から30分）を過ぎたら作り直す
```

URLは購入者本人にだけ渡します。すでに購入済みで購入制限に達していると `CozeniError`（`code: 'already_purchased'`、`status: 409`）になるので、「購入済み」として扱います。ほかに `product_not_found`（`status: 404`。存在しない、ほかの販売者の、または別の環境の商品ID）・`creator_not_ready`（販売の準備が未完了）・`product_archived` / `checkout_link_disabled`（販売できない商品）があります。

**サンドボックスの購入画面は、販売者本人のメールアドレスにだけ作れます。** ほかのメールアドレスでは `CozeniError`（`code: 'sandbox_recipient_not_allowed'`、`status: 422`）になります。試すときは、販売者本人のメールアドレスのアカウントでログインします。

### 購入者の機能フラグを照会する

```ts
import {getCustomerState, hasFeatureFlag} from '@nulogic/cozeni-sdk/next';

// 付与済みの機能フラグをすべて
const state = await getCustomerState({email: session.user.email});
// => { customerId: string | null, featureFlags: [{ productId, benefitId, grantedAt, metadata }] }

// 特定の商品だけ。無ければ { granted: false, metadata: {} }
const {granted, metadata} = await hasFeatureFlag({
  email: session.user.email,
  productId: process.env.COZENI_PRO_PRODUCT_ID!,
});
```

メールアドレスはURLではなくPOSTの本文で送り、エラーにも保持しません。購入者・権利が無いときも成功（`customerId: null`・空配列）で、購入の有無の判定には使えません（`customerId` は機能フラグの権利が1件以上あるときだけ入ります）。照会の失敗（認証・レート制限・通信など）は握りつぶさず `CozeniError` で投げます。レート制限は `code: 'rate_limited'` と `retryAfterSeconds` で返ります。SDKは自動で再送しません。

### 上限をサーバーで数えて止める

設定値は上限などに使い、使った量はアプリのサーバーで数えます。

```ts
import {CozeniError, hasFeatureFlag} from '@nulogic/cozeni-sdk/next';

export async function POST(request: Request) {
  const user = await requireLoginUser(request); // 本人確認済みのメールアドレス
  let flag: Awaited<ReturnType<typeof hasFeatureFlag>> = {
    granted: false,
    metadata: {},
  };
  try {
    flag = await hasFeatureFlag({
      email: user.email,
      productId: process.env.COZENI_PRO_PRODUCT_ID!,
    });
  } catch (error) {
    // 照会の上限（rate_limited）は、機能を使わせない側（無料枠）に倒す。ほかの失敗は握りつぶさない
    if (!(error instanceof CozeniError && error.code === 'rate_limited'))
      throw error;
  }
  const {granted, metadata} = flag;
  const limit =
    granted && typeof metadata.daily_messages === 'number'
      ? metadata.daily_messages
      : FREE_DAILY_MESSAGES;
  if ((await countTodayMessages(user.id)) >= limit)
    return Response.json({error: 'limit_reached'}, {status: 429});
  // ここから先が機能の本体
}
```

### 結果のキャッシュ（60秒まで）

同じ購入者の結果は、最大60秒キャッシュしてかまいません。照会はリクエストごとに行いうるので、サーバーのメモリなどで短く持ちます。**キャッシュするのは付与済み（`granted: true`）の結果だけです。** 未購入の結果を残すと、購入した直後の最大60秒、購入済みなのに未購入と判定されます。剥奪の反映は、キャッシュの期限の60秒以内です。

```ts
type Flag = Awaited<ReturnType<typeof hasFeatureFlag>>;
const MAX_ENTRIES = 1000;
// 期限はすべて同じ60秒なので、Mapの挿入順が期限の順になる。
const cache = new Map<string, {expires: number; value: Flag}>();

function remember(key: string, value: Flag) {
  const now = Date.now();
  cache.delete(key); // 入れ直して、末尾（いちばん新しい）に置く
  for (const [oldKey, entry] of cache) {
    if (entry.expires > now) break; // 先頭から、期限切れだけを消す
    cache.delete(oldKey);
  }
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest); // 最大件数を超えたら古いものから消す
  }
  cache.set(key, {expires: now + 60_000, value});
}

async function cachedHasFeatureFlag(
  email: string,
  productId: string,
): Promise<Flag> {
  const key = `${productId}:${email.trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await hasFeatureFlag({email, productId}); // 失敗は投げるので残らない
  if (value.granted) remember(key, value);
  else cache.delete(key); // 期限切れの古い付与済みの結果を残さない
  return value;
}
```

未購入の結果はキャッシュしないので、未購入のユーザーの照会は毎回APIに届きます。照会はキーごとに600回/分が上限で、超えると `rate_limited`（`retryAfterSeconds` を見る）になります。そのときは機能を使わせない側に倒します（上の上限の例なら、`CozeniError` の `code === 'rate_limited'` を `catch` して、無料枠の上限で判定します）。

キャッシュはサーバーのメモリだけに置き、メールアドレスをログや外部のストア・分析に出さないでください。

### 購入直後は照会し直す

権利は決済の完了後に作られるため、購入完了ページへ戻った直後は数秒だけ照会に出ないことがあります。見つからなければ、2秒おきに最大3回だけ照会し直します（キャッシュは使いません）。

```ts
async function waitForFeatureFlag(email: string, productId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await hasFeatureFlag({email, productId});
    if (result.granted) return result;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return {granted: false, metadata: {}}; // まだ反映されていない。あとで案内する
}
```

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

接続先は `apiOrigin` か `environment`（`"production"` / `"sandbox"`）で指定します。どちらも無ければ本番です。両方を渡した場合、`apiOrigin` がその環境のオリジンと違えば作成時に `invalid_input` を投げます。

両clientに `fetch` と `timeoutMs`（既定10秒）を注入できます。エラーは `CozeniError`（`code` / `status` / `requestId` / `retryAfterSeconds`）で、秘密や生の応答を保持しません。

### 購入者ポータルへ送る

サイトですでに入場している購入者を、確認コードの入力なしでCozeniの購入者ポータル（その販売者から購入した商品の一覧）へ送れます。サイトに `/portal` のようなルートを置き、「購入した商品」などのボタンはそのルートへのリンクにします。ルートのサーバー処理が `createPortalLink()` でURLを発行し、そのURLへ302でリダイレクトします。

```ts
import {CozeniError, createCustomerClient} from '@nulogic/cozeni-sdk';

const customer = createCustomerClient({environment: 'production'});
const creatorId = 'cre_...'; // 販売者のクリエイターID（秘密ではない）

// GET /portal
export async function portal(request: Request): Promise<Response> {
  const headers = {'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer'};
  try {
    const {url} = await customer.createPortalLink({
      cookieHeader: request.headers.get('cookie') ?? undefined,
      creatorId,
    });
    return new Response(null, {status: 302, headers: {...headers, Location: url}});
  } catch (error) {
    if (error instanceof CozeniError && error.code === 'no_session') {
      // このサイトで入場していない。コード無しのポータルは、確認コードでの入場へ進める。
      const portal = `https://checkout.cozeni.net/portal/${creatorId}`;
      return new Response(null, {status: 302, headers: {...headers, Location: portal}});
    }
    return new Response('時間をおいてもう一度お試しください。', {status: 503, headers});
  }
}
```

- 返るURLは60秒・1回限りのコード付きです。**ページの描画時に発行して `<a href>` へ埋め込まないでください**（60秒で切れます。切れたURLを開いた購入者は、Cozeniの確認コードでの入場に進みます）。ボタンは押されたときに発行するルートへのリンクにし、prefetchされる仕組み（Next.jsの `<Link>` など）を使いません。
- 返ったURLとコードを、アクセスログ・解析・エラー報告・レスポンスのキャッシュに残さないでください。
- 送り先はAPIの応答と自分で決めたクリエイターIDだけで決め、リクエストのクエリ（`?next=` など）からは受け取りません（オープンリダイレクトを作らないため）。
- `cozeni_customer` Cookieだけを転送します。Cookieが無い・不正ならAPIを呼ばずに `no_session` を投げます。APIの401も `no_session`、503は `unavailable`、通信の失敗は `network_error` / `timeout` です。`unavailable` などの障害を再入場の要求に変えないでください。
- URLは構造で検証してから返します（httpsが必須、httpはloopbackだけ、userinfo・fragment無し、pathnameは `/portal/{クリエイターID}`、クエリは `cozeni_portal_code` の1個だけ）。`environment` か既知のAPIオリジンで本番・サンドボックスにつないでいれば、URLのオリジンがその環境の購入者面（上の「サンドボックス」の表の購入リンクのオリジン）と一致することも確かめます。`creatorId` を渡すと、URLのクリエイターIDが一致することも確かめます。合わなければ `invalid_response` を投げます。
- コード無しのポータル（`{購入者面のオリジン}/portal/{クリエイターID}`）は、Cozeni側のセッションがあれば一覧を出し、無ければ確認コードでの入場へ進めます。サンドボックスでは購入者面のオリジンを `https://checkout-sandbox.cozeni.net` にします。

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
<a href="https://checkout.cozeni.net/checkout/...">購入する</a>
```

```ts
// app/portal/route.ts（購入者ポータルへ送るボタンの遷移先）
import { portalRedirect } from "@nulogic/cozeni-sdk/next";

export const dynamic = "force-dynamic";

export function GET() {
  return portalRedirect("cre_..."); // クリエイターID（`npx cozeni whoami --json` の creator_id）
}
```

```tsx
// ボタン。<Link>にしない（prefetchで、押す前にリンクを発行させない）
<a href="/portal">購入した商品</a>
```

| API | 振る舞い |
|---|---|
| `cozeniProxy(request)` | `?cozeni_code` 付きのGETでコードを交換し、`cozeni_customer` を設定して、コードを除いた同じURLへ303で戻す。結果は1回だけ有効な `cozeni_handoff` Cookie（`ok` / `invalid_code` / `unavailable`、60秒）で伝え、次のリクエストではページへ通したうえで応答で消す |
| `handleCozeniHandoff(request, options?)` / `clearCozeniHandoff(request, response)` | 既存のmiddleware / proxyと組み合わせる用。前者はコードの交換だけを行い `Response \| undefined` を返す。後者は既存の応答に印の消去を足す |
| `requireEntitlement(productId)` | page専用。権利が無ければ `enter_url` へリダイレクトする。`cozeni_handoff` の印があればリダイレクトせず `AccessDenied` を投げる（印が `unavailable` なら理由も `unavailable`） |
| `entitlement(productId)` / `denialResponse(result, productId)` | Route Handler・Server Action用。リダイレクトしない |
| `createCheckout({productId, email})` / `getCustomerState({email})` / `hasFeatureFlag({email, productId})` | Route Handler・Server Action用。機能フラグの購入画面の作成と購入者の照会（上の「機能フラグ」）。キーは環境変数 `COZENI_API_KEY`、接続先は `COZENI_ENVIRONMENT` から決める。設定が不正なら `invalid_input`。`NEXT_PUBLIC_COZENI_API_KEY` があれば使わずに拒否する |
| `portalRedirect(creatorId, options?)` | Route Handler用。購入者ポータルへのリンクを発行して302で送る。このサイトで入場していなければ、コード無しのその販売者のポータル（Cozeniが確認コードでの入場へ進める）へ302。発行できなければ503（応答が合わない、たとえば返ったURLの販売者やオリジンが違うときは、クリエイターIDと `COZENI_ENVIRONMENT` の確認を促す固定文をサーバーのログに出す）。`COZENI_API_ORIGIN` で独自の接続先を使うときは購入者面のオリジンが分からないので、入場していなければ401を返す |

戻り先のオリジンは `COZENI_SITE_ORIGIN` に固定し、`Host` ヘッダーを信用しません。**サイトは1つのオリジンで公開してください**（例：`www` の有無をリダイレクトで統一する）。`COZENI_SITE_ORIGIN` と違うホストでアクセスされた場合もコードの交換は行われますが、購入者のCookieはアクセスされたホストに付き、戻り先の `COZENI_SITE_ORIGIN` には届きません。単回のコードは消費されるため、購入者はメールアドレスでの再入場が必要になります。**購入者限定ページだけなら、本番で必要な環境変数は `COZENI_SITE_ORIGIN` だけです。** 機能フラグを使うサイトは、これに加えて `COZENI_API_KEY`（サーバーだけに置くAPIキー）が必要です（上の「機能フラグ」の「キーと環境変数」）。APIオリジンの既定値は `https://api.cozeni.net` です。サンドボックスにつなぐときは `COZENI_ENVIRONMENT=sandbox` を設定します（上の「サンドボックス」）。Cozeniを手元で動かす開発時だけ `COZENI_API_ORIGIN` で上書きします。商品IDと購入リンクは秘密ではないので、コードに直接書きます。

**リダイレクトするのはpageの入口だけです。** `requireEntitlement()` はnext/navigationの `redirect()`（制御フロー例外）を投げることがあります。呼び出しは `AccessDenied` だけを捕捉し、それ以外はcatchで握りつぶさず上位へ伝播させてください。**Route Handler（JSON API）**は `entitlement()` の結果を `denialResponse()` へ渡し、401/403/503のJSONへ `enter_url` を含めます。**Server Action**はWeb Responseを返さず、`entitlement()` の結果の理由をplain objectとして返します。

| 境界 | 実装 |
|---|---|
| ハンドオフ | `proxy.ts` |
| ページ / HTML / RSC | `app/members/page.tsx`（`requireEntitlement`） |
| Route Handler | `app/api/protected/route.ts`（401 / 403 / 503とenter_urlをJSONで返す） |
| Server Action | `app/members/actions.ts` |
| 購入ボタン・購入者ポータルへのボタン | `app/page.tsx` |
| 購入者ポータルへ送るルート | `app/portal/route.ts`（`portalRedirect`） |

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

CLIのテスト（`tests/cli.test.ts`・`tests/cli-sandbox-flow.test.ts`・`tests/cli-store.test.ts`）は、通信をモックし、一時ディレクトリを `XDG_CONFIG_HOME` にして、保存ファイルの権限と置き換えを含めて検証します。
