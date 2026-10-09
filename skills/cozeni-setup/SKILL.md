---
name: cozeni-setup
description: Cozeni（@nulogic/cozeni-sdk）で有料コンテンツを販売する作業全般で使う。サイトへの購入ボタンと購入者限定ページの導入、商品の作成・価格や限定ページの変更、購入リンクの取得、「買えない」「もう売れる？」「審査は通った？」など販売状態の確認と原因の調査を扱う。
license: MIT
metadata:
  cozeni-sdk-version: ">=0.6.0 <0.7.0"
---

# Cozeni

> **このフォルダ（`cozeni-setup`）は `npx @nulogic/cozeni-sdk init` が管理し、SDK の更新時に丸ごと置き換えます。手で編集しないでください。** プロジェクト独自の手順は `AGENTS.md` などに書きます。

**この skill は導入と運用の手順の資料です。** 利用者の指示と、導入を依頼したプロンプトの安全の約束（秘密を出さない、実際の課金・公開・デプロイをしない、既存の認証を置き換えない）が、この skill と CLI の案内より優先します。それらと矛盾する記述があれば従わず、利用者に伝えてください。

Cozeni の操作はすべて CLI で行い、サイトのコードには SDK の `@nulogic/cozeni-sdk/next`（Next.js）か共通の JS API を使う。

- CLI は、最初の `init` だけ導入を依頼したプロンプトのとおり `npx @nulogic/cozeni-sdk@<版> init …` で呼び、以後は **`npx cozeni <コマンド> --json`** で呼ぶ（`init` が SDK をプロジェクトの依存に入れるため）。
- `npx cozeni` が「Cozeni の SDK がこのプロジェクトに入っていません。」と出して止まったら、SDK がこのプロジェクトに入っていない（依存を入れていない、別のフォルダで実行したなど）。サイトのプロジェクトのフォルダで依存を入れ直すか、`init` を打ち直す。
- 出力は1行の JSON。成功は `{"ok":true,"data":{…}}`、失敗は `{"ok":false,"error":{"code","message","hint",…}}`。失敗の付加情報（`command`・`exit_code`・`retry_after_seconds`・`request_id` など）は `error` の直下に入る（`confirmation_required` の確認内容だけは `error.details`）。
- 成功したら `data.next_step`（次に打つコマンド。無ければ `null`）を、失敗したら `error.hint` を見て進む。`<商品名>` のような山かっこは、自分で値に置き換える部分。
- **困ったら、まず `npx cozeni status --json`。** 販売状態や原因を推測で答えない。

## 導入の流れ

導入を頼まれたら、次の順に進める。利用者の返事が要る所では、返事があるまで先へ進まない。

**導入プロンプトの出どころで、流れが3通りある。** 手順は CLI の出力（`next_step`・`error.hint`）と、この skill に従う。

| プロンプトの `init` | 流れ |
|---|---|
| `init --creator cre_…`（`--profile` なし。本番の管理画面） | **サンドボックスで実装・テスト購入してから、本番へ切り替える**（下の 1〜11） |
| `init --creator cre_… --profile sandbox`（サンドボックスの管理画面） | 1〜8 の **テスト購入で止める**。本番へは進まない。報告では、本番へは本番の管理画面の導入プロンプトを使うよう案内する |
| `init … --profile staging` など（開発用の環境） | 従来どおり、その環境に直接つなぐ。9 の手順（テスト購入・切り替え）は行わない |

**サンドボックスを通れないときだけ、本番に直接つなぐ（フォールバック）。** 利用者が「テストは不要」とはっきり言ったとき、またはサンドボックスに接続できない・登録できないときに限る。こちらから勧めない。`npx @nulogic/cozeni-sdk@<版> init --creator cre_… --profile production --json` で本番を既定にし、サンドボックスの手順（テスト購入・切り替え）を飛ばして、本番に直接導入する。**報告の先頭に、テスト購入をしていないことを書く。**

### 1. 準備（`init`）

導入を依頼したプロンプトにある `init` のコマンドを、サイトのプロジェクトのフォルダで実行する（例：`npx @nulogic/cozeni-sdk@<版> init --creator cre_… --json`）。SDK を依存に追加し、この skill を `.agents/skills/`（Claude Code では `.claude/skills/` にも）へ置き、接続先と使うアカウントを覚える。何度実行してもよい。

- `--profile` を付けない `init` は、本番のクリエイターIDを本番の期待値として保存し、既定の接続先をサンドボックスにする。以後のコマンドに `--profile` は要らない（既定の接続先につながる）。
- `error.code` が `install_failed` なら、`error.command` を自分で実行してエラーを確かめ、直してから `init` を打ち直す。
- `package_manager_conflict` なら、`package.json` の `packageManager` と lockfile が食い違っている。どちらを使っているか利用者に確かめ、揃えてから打ち直す。
- `unsafe_path` なら、skill の置き場所（`.agents`・`.claude` など）がシンボリックリンクかプロジェクトの外を指している。`error.message` を利用者に伝え、どうするか確かめる。

### 2. ログイン（`login`）

1. `npx cozeni login --json` を実行する。
   - `data.already_logged_in` が `true` なら、ログイン済み。3へ進む。
   - そうでなければ、すぐに終わって `data.verification_uri_complete`（無ければ `data.verification_uri`）と `data.user_code`、そして `data.next_step`（利用者への伝え方）を返す。
2. 利用者に「このURLをブラウザで開き、表示されたコードが `<user_code>` と同じか確かめてから許可してください」と伝え、**許可したと返事があるまで待つ**。
   - 既定の接続先がサンドボックスのとき、**この依頼で1回だけ**「実際にはお金が動かないテスト用の環境（サンドボックス）」と説明し、まだ登録していなければ承認の画面から会員登録してもらう（メール確認のあと承認の画面に戻る。販売者の情報の申請は求めない）。**以後は「サンドボックス」と言わず「テスト」と呼ぶ。**
3. `npx cozeni login --complete --json` を実行する。
   - 終了コード6（`authorization_pending`）：まだ許可されていない。利用者に許可したか確かめてから、同じコマンドを打ち直す。
   - 終了コード3（`access_denied`・`expired_token` など）：手順1の `login` からやり直す。
   - `creator_mismatch`（終了コード4）：ブラウザで別の Cozeni アカウントにログインした状態で許可された。`error.message` を利用者に伝え、正しいアカウントでブラウザにログインし直してもらってから、手順1の `login` からやり直す。

### 3. 状態の確認（`status`）

`npx cozeni status --json` で、接続先（`data.environment`）、クリエイター、販売状態、既存の商品を確かめる。`next_actions` があっても導入は続けてよい。

**テスト用の接続先（`data.environment` が `sandbox`）で売上の受け取り先の登録が未完了なら、`data.next_step` に従う。** 5 の商品の確認と同じ1通で、利用者に売上の受け取り先のテスト登録を頼む（決済サービスの画面では、銀行口座は「テストアカウントを使用する」、本人確認は「シミュレーション」→「確認成功」→「結果を送信する」を使い、SMS のコードを聞かれたら `000-000` を入力する。名前・生年月日・住所・電話番号などそのほかの入力値は、導入プロンプトの「売上の受け取り先のテスト登録」の値を伝える。URL は `data.next_actions` の `action_url`）。手元のプロンプトにその節が無いときは、入力値を推測で作らず、Cozeni の管理画面（**設定 → 開発者**）の導入プロンプトにある同じ節を利用者に見てもらう。**登録を待たずに** 商品の作成と実装を進め、`test-purchase`（8）の前にもう一度 `status` で `sales.can_sell` が `true` になったことを確かめる。

### 4. サイトのアドレス（`siteOrigin`）を決める

商品の `access_url`（購入後に表示するページ）と、環境変数 `COZENI_SITE_ORIGIN` に使う。オリジン（`https://example.com` のようにパスを含まない形）で決める。

- **テスト用の接続先（サンドボックス）・開発**：開発サーバーのアドレス（例：`http://localhost:3000`）。Next.js 15 では `127.0.0.1` ではなく `localhost` にする。`test-purchase` はこのアドレスにしか使えない（ループバックのみ）。
- **本番**（staging・production を含む）：公開中の https のアドレスを探す。`package.json` の `homepage`、README、ホスティングの設定（`vercel.json`・`netlify.toml`・`CNAME` など）、`.env.example`、`metadataBase` やサイトマップの設定などを見る。見つけた値を「このアドレスで公開していますか」と利用者に確かめる。見つからなければ利用者に尋ねる。推測した値のまま進めない。
- **サンドボックスから始めるとき**は、開発サーバーのアドレスで実装し、**本番の公開アドレスも 5 の確認の1通で一緒に聞いておく**（本番の商品を作るときに聞き直さないため）。

### 5. 商品を決める

`status` の `data.products` を見て、利用者に何を売るかを確かめる。

- **既存の商品を使う**：`npx cozeni products get <商品ID> --json` で内容と購入リンクを確かめる。`data.checkout_link` が `null`（未発行）なら、利用者に確認してから `npx cozeni link <商品ID> --json` で発行する。
- **新しく作る**：**商品名・価格（円、50〜9,999,999の整数）・購入後に表示するページのURL**（`<siteOrigin>/<限定ページのパス>`）を、利用者に1回でまとめて確認する（サンドボックスから始めるときは、3 の売上の受け取り先の登録の依頼と、本番の公開アドレスの確認も同じ1通に入れる）。同意を得たら次を実行する。

  ```sh
  npx cozeni products create --name "<商品名>" --price <円> --access-url "<URL>" --yes --json
  ```

  - 同じ内容の有効な商品がすでにあれば、作らずにそれを返す（`data.reused: true`、`data.reason: "same_product_exists"`）。それを使う。`data.checkout_link` が `null` なら、利用者に確認してから `data.next_step` の `link` を実行する。
  - `--allow-duplicate` は、利用者が同じ内容の別の商品をはっきり求めたときだけ付ける。

出力の `data.product.id`（`prd_…`）と `data.checkout_link.url` を、そのままコードに書く。環境変数にはしない。

### 6. サイトのコードを書く

フレームワークに合わせて次の資料に従う。既存の認証・middleware・proxy は置き換えず、組み込む。

- **Next.js（App Router）**：[references/nextjs.md](references/nextjs.md)
- **それ以外の JavaScript / TypeScript サーバー**：[references/javascript-server.md](references/javascript-server.md)
- 静的ファイルだけのサイトでは限定ページを守れない。サーバーの処理（SSR・serverless function・Worker など）が無ければ、作業を止めて利用者に説明する。

手元の環境変数（例：`.env.local`）に `COZENI_SITE_ORIGIN=<siteOrigin>` を設定する。`status` の `data.environment` が `sandbox` なら、`COZENI_ENVIRONMENT=sandbox` も設定する（無いとサイトが本番の Cozeni に問い合わせ、サンドボックスの商品の購入者を認められない）。サイトに必要な環境変数はこれだけで、API キーは使わない。

### 7. 動作確認

開発サーバーを起動し、**購入していない状態**で次を確かめる。決済画面は操作しない。購入は 8 の `test-purchase` だけで行う。

- **限定ページ**：Cozeni の再入場画面（`enter_url`）へリダイレクトされる。例：`curl -sI <siteOrigin>/<限定ページ>` で 3xx と、`Location` が Cozeni の `/enter?product_id=<商品ID>` であること。
- **Route Handler など JSON を返す入口**：リダイレクトせず、401（未ログイン）・403（未購入・取り消し）・503（一時障害）の JSON を返す。例：`curl -si <siteOrigin>/api/<パス>`。
- **Server Action**：Response やリダイレクトではなく、拒否を示す通常の値（例：`{ ok: false, reason: "no_session" }`）を返す。画面から操作するか、テストで確かめる。
- プロジェクトにビルド・型検査・lint・テストのコマンドがあれば実行する。

### 8. テスト購入（`test-purchase`。サンドボックスだけ）

開発サーバーを起動したまま、`npx cozeni test-purchase --product <prd_…> --site-origin <開発サーバーのアドレス> --json` を実行する。**サーバーがテストカードで決済を確定させ、CLI が限定ページに入れることと、未購入では `enter_url` へ送られることを確かめて返金する。** ワンタイムコードは出力されない。決済画面は操作しない。`--site-origin` は `localhost`・`127.0.0.1`・`[::1]` のアドレスに限る。本番（`production` プロファイル）では動かない。

- 終了コード6（`authorization_pending`）：購入権ができるまで待っている。同じコマンドを打ち直す（二重に決済しない）。
- `creator_not_ready`（終了コード4）：売上の受け取り先の登録が済んでいない。`error.hint` に従い、利用者に登録を頼んで待ち、`status` で確かめてから打ち直す。
- `entry_check_failed`（終了コード4）：限定ページに入れない、または未購入でも `enter_url` へ送られない。`error.hint`・`error.reason` を見てコードを直し、打ち直す（購入権は残っているので、決済せず確認から行い、確認が済んだら返金する）。
- `site_unreachable`（終了コード5）：開発サーバーに届かない。起動を確かめて打ち直す。
- 成功したら `data.next_step` に従い、**1通で次を利用者に伝える**。
  1. テスト購入が通ったこと（購入後は限定ページに入れ、未購入では入場画面へ送られた。確認のあと返金した）。
  2. 「ご自身でも購入から入場まで試せます」：開発サーバーの購入ボタンから、テストカード `4242 4242 4242 4242`、ログイン用のメールアドレスで購入し、メールに届くコードで入る。開発サーバーはこの案内のあいだ動かしておく。
  3. 「サンドボックスで確認できたので、本番を導入してよいですか？」と尋ねる（自分で試すなら、試し終わってから返事をもらう）。**返事を待つ。** 本番のログインはまだ始めない。
- **サンドボックスの管理画面のプロンプトから来たときは、ここで止める**（1・2 を伝え、本番の承認は頼まない。本番へは本番の管理画面の導入プロンプトを使うよう案内する）。

### 9. 本番への切り替え

利用者が本番への導入を許可したら、`npx cozeni login --profile production --json` を実行し、本番の承認URLとコードを渡して許可してもらう。許可されなかったら本番へは進まず、テスト用の環境のまま終える。

- 承認の返事を待ち、`npx cozeni login --complete --profile production --json` を実行する。本番のアカウントが `init` で覚えたものと一致すれば、CLI が既定の接続先を本番に書き換える（`data.switched_to_production: true`）。別のアカウントなら `creator_mismatch` で止まり、切り替えない。
- 本番にログイン済みで一致しているときは、承認URLは出ない。本番への導入はすでに許可を得ているので、`npx cozeni switch --json` で切り替える。
- 切り替えたあと、`data.next_step` に従う。テストで確定した商品名・価格・限定にする内容のまま、**聞き直さずに** 本番で同じ内容の商品を作る（`products create`。同じ内容があれば作らずに返る。`--access-url` は 5 で聞いた本番の公開アドレス）。コード中の商品IDと購入リンクを本番のものに差し替え、`COZENI_ENVIRONMENT` を外す。**本番では決済を試さず**、7 の「購入していない状態で `enter_url` へリダイレクトされる」確認までを行う。

### 10. `AGENTS.md` への案内

プロジェクトの `AGENTS.md`（無ければ `CLAUDE.md`）に、下の「AGENTS.md への案内」を追記する。

### 11. 報告

最後にもう一度 `npx cozeni status --json` を実行し、次の順で報告する。

1. **サンドボックスを通らず本番に直接つないだときは、テスト購入をしていないことを最初に書く。**
2. **`data.message_for_user` の各行を、言い換えずにそのまま書く**（販売できるなら「すぐ販売できます。」）。
3. 公開先の設定：「公開しているサイトの環境変数に `COZENI_SITE_ORIGIN=<公開中のアドレス>` を設定してください。未設定だと、購入後に限定ページを開けません」。設定やデプロイは利用者が行う。自分では行わない。
4. したこと（商品・購入リンク・変更したファイル）と、確かめたこと・確かめられなかったこと。追加されたファイル（`.agents/skills/` など）はプロジェクトと一緒にコミットするよう伝える。

## 確認が必要な操作

商品の作成、価格の変更、購入後に表示するページ（`access_url`）の変更は、`--yes` が無ければ実行されず `confirmation_required`（終了コード2）で止まる。`access_url` の変更は、既存の購入者全員にすぐ反映される。

`--yes` は、利用者が内容に同意してから付ける。`confirmation_required` が返ったら、`error.message` と `error.details` を利用者に見せて確認する。名前だけの変更は確認なしで実行される。購入リンクの発行（`link`）も、利用者に確認してから行う。

## 終了コード

| コード | 意味 | すること |
|---|---|---|
| 0 | 成功 | `data.next_step` があれば、それが次のコマンド |
| 1 | 想定外のエラー | `error.message` を利用者に伝える。`install_failed` なら `error.command` を実行して原因を確かめる。`package_manager_conflict`・`unsafe_path` は上の「1. 準備」 |
| 2 | 使い方の誤り・確認が必要 | 引数を直す。`confirmation_required` なら利用者に確認して `--yes` を付ける。`environment_mismatch` は本番とサンドボックスのキーの取り違えで、`error.hint` に従う。`test_purchase_unavailable`・`site_origin_not_allowed` は `test-purchase` を送らずに止めた（本番、またはループバック以外のアドレス） |
| 3 | ログインが必要 | `login` からやり直す。`key_expired` は30日の期限切れで、異常ではない |
| 4 | 権限・規約・状態で拒否 | `terms_consent_required` なら、利用者に管理画面で規約への同意を頼む。`creator_mismatch` は別のアカウントのキー。`creator_not_ready`・`entry_check_failed` は上の「8. テスト購入」。`error.hint` に従う |
| 5 | 通信できない・一時障害 | 下の「通信できないとき」。`rate_limited` は `error.retry_after_seconds` 秒待って再実行する |
| 6 | 承認待ち | 利用者の承認を待ち、`login --complete` を打ち直す。`test-purchase` では購入権ができるまで待っているので、同じコマンドを打ち直す |

### 通信できないとき

`network_unreachable` は、ネットワークの設定で Cozeni への通信が止められていることが多い。とくにクラウドで動く AI ツールは、既定で外部への通信が制限されている。`error.hint` にある手順（許可するドメインに `api.cozeni.net` などを加える）を利用者に伝え、設定を変えてもらってから同じコマンドを打ち直す。自分で回避策を探さない。

## 販売状態の読み方（`status --json`）

- `data.message_for_user`：利用者にそのまま見せる「次にやること」。言い換えない。
- 利用者には「Stripe」「連携」と言わず、管理画面と同じ「売上の受け取り先の登録」「販売者の情報の申請」と呼ぶ。手続きが複数あるときは `data.message_for_user` の順番（受け取り先 → 販売者の情報）のまま伝える。
- `data.sales.can_sell` が `true`：アカウントとしては販売できる。それでも買えないなら、`data.products` で対象商品の `status` を確かめる。
- `data.next_actions`：販売を始めるまでに利用者がすること。各項目に `message` と `action_url` がある。`review_rejected` には `rejection.reason_code` と `rejection.note`（差し戻しの理由）が付く。
- `data.sales.warnings` に `payouts_disabled`：販売はできるが、売上の入金が止まっている。
- `data.sales` が `null`：接続先の API が販売状態の取得に対応していない。原因を推測しない。
- `data.warnings` に `key_expiring`：ログインの期限（30日）が7日以内に切れる。`login` で更新する。

## してはいけないこと

- ログインで保存されたキー（`~/.config/cozeni/credentials.json`）を読まない。サイトのコード・`.env`・本番の環境変数にキーを書かない。本番のサイトはキーを使わない。
- 商品IDや購入リンクを推測で書かない。CLI の出力を使う。
- 利用者の同意なしに `--yes` を付けない。公開、デプロイ、本番の環境変数の変更をしない。
- 決済画面を操作しない。テスト購入は `test-purchase` のコマンドでだけ行う。本番で実際の課金をしない。
- `test-purchase` の出力にないワンタイムコードや購入者の Cookie を、自分で取り出したり、チャット・ログに書いたりしない。
- 既存の認証・middleware・proxy を置き換えない。

## AGENTS.md への案内

```md
## Cozeni
購入・販売の設定や「買えない」などの問い合わせは、Cozeni の skill に従う。
最初に `npx cozeni status` で販売状態を確認する。推測で答えない。
```
