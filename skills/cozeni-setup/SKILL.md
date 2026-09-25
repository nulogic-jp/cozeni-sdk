---
name: cozeni-setup
description: Cozeni（@nulogic/cozeni-sdk）で有料コンテンツを販売する作業全般で使う。サイトへの購入ボタンと購入者限定ページの導入、商品の作成・価格や限定ページの変更、購入リンクの取得、「買えない」「もう売れる？」「審査は通った？」など販売状態の確認と原因の調査を扱う。
license: MIT
metadata:
  cozeni-sdk-version: ">=0.5.0 <0.6.0"
---

# Cozeni

Cozeni の操作はすべて CLI で行い、サイトのコードには SDK の `@nulogic/cozeni-sdk/next`（Next.js）か共通の JS API を使う。

- CLI は **`npx @nulogic/cozeni-sdk <コマンド> --json`** で呼ぶ。`npx cozeni` は使わない（別のパッケージが実行されうる）。
- 出力は1行のJSON（成功は `{"ok":true,"data":…}`、失敗は `{"ok":false,"error":{"code","message","hint"}}`）。失敗したら `error.hint` に従う。
- **困ったら、まず `npx @nulogic/cozeni-sdk status --json`。** 販売状態や原因を推測で答えない。

## 導入の流れ

1. SDK を依存に入れる。対象サイトの package manager を使う（例：`npm i @nulogic/cozeni-sdk`）。
2. ログインする（2段階）。
   1. `npx @nulogic/cozeni-sdk login --json` を実行する。すぐに終わり、`verification_uri_complete`（無ければ `verification_uri`）と `user_code` を返す。
   2. 利用者に「このURLをブラウザで開き、表示されたコードが `<user_code>` と同じか確かめてから許可してください」と伝え、許可したと返事があるまで待つ。
   3. `npx @nulogic/cozeni-sdk login --complete --json` を実行する。終了コード6（`authorization_pending`）なら、利用者に許可を確かめてから同じコマンドを打ち直す。終了コード3なら手順1からやり直す。
3. `npx @nulogic/cozeni-sdk status --json` で接続先と販売状態を確かめる。`next_actions` があっても導入は続けてよい（最後に利用者へ伝える）。
4. 商品を決める。既存の商品を使うなら `products list` の `id` と、`link <商品ID>` の `url` を使う（1件の内容と購入リンクの状態だけを見るなら `products get <商品ID>`）。新しく作るなら、**商品名・価格（円）・購入後に表示するページのURL**を利用者に1回でまとめて確認してから、次を実行する。

   ```sh
   npx @nulogic/cozeni-sdk products create --name "<商品名>" --price <円> --access-url "<URL>" --yes --json
   ```

   出力の `product.id`（`prd_…`）と `checkout_link.url` をそのままコードに書く。環境変数にはしない。
5. サイトのコードを書く。フレームワークに合わせて次の資料に従う。
   - **Next.js（App Router）**：[references/nextjs.md](references/nextjs.md)
   - **それ以外のJavaScript / TypeScriptサーバー**：[references/javascript-server.md](references/javascript-server.md)
   - 静的ファイルだけのサイトでは限定ページを守れない。サーバーの処理（SSR・serverless function・Worker など）が無ければ、作業を止めて利用者に説明する。
6. ローカルの環境変数に `COZENI_SITE_ORIGIN`（自サイトのオリジン。例：`http://localhost:3000`）を設定する。本番で必要な環境変数はこれだけ。
7. 開発サーバーを起動し、購入していない状態で限定ページを開くと Cozeni の再入場画面（`enter_url`）へリダイレクトされることを確かめる（例：`curl -sI http://localhost:3000/members` の `Location`）。実際の購入は試さない。
8. プロジェクトの `AGENTS.md`（無ければ `CLAUDE.md`）に、下の「AGENTS.md への案内」を追記する。
9. 報告の先頭に「次にやること」を書く。本番環境に `COZENI_SITE_ORIGIN` を設定すること、`status` の `next_actions`（審査・Stripe の手続き）をそのまま伝える。

## 確認が必要な操作

商品の作成、価格の変更、購入後に表示するページ（`access_url`）の変更は、`--yes` が無ければ実行されず `confirmation_required`（終了コード2）で止まる。`access_url` の変更は、既存の購入者全員にすぐ反映される。

`--yes` は、利用者が内容に同意してから付ける。`confirmation_required` が返ったら、`error.message` と `error.details` を利用者に見せて確認する。名前だけの変更は確認なしで実行される。

## 終了コード

| コード | 意味 | すること |
|---|---|---|
| 0 | 成功 | — |
| 1 | 想定外のエラー | `error.message` を利用者に伝える |
| 2 | 使い方の誤り・確認が必要 | 引数を直す。`confirmation_required` なら利用者に確認して `--yes` を付ける |
| 3 | ログインが必要 | `login` からやり直す。`key_expired` は30日の期限切れで、異常ではない |
| 4 | 権限・規約・状態で拒否 | `terms_consent_required` なら、利用者に管理画面で規約への同意を頼む |
| 5 | 通信できない・一時障害 | `network_unreachable` なら `error.hint` のネットワーク許可の手順を利用者に伝える。`rate_limited` は `retry_after_seconds` 秒待って再実行する |
| 6 | 承認待ち | 利用者の承認を待ち、`login --complete` を打ち直す |

## 販売状態の読み方（`status --json`）

- `data.sales.can_sell` が `true`：アカウントとしては販売できる。それでも買えないなら、`data.products` で対象商品の `status` を確かめる。
- `data.next_actions`：販売を始めるまでに利用者がすること。各項目の `message` と `action_url` をそのまま伝える。`review_rejected` には `rejection.reason_code` と `rejection.note`（差し戻しの理由）が付く。
- `data.sales.warnings` に `payouts_disabled`：販売はできるが、売上の入金が止まっている。
- `data.sales` が `null`：接続先の API が販売状態の取得に対応していない。原因を推測しない。
- `data.warnings` に `key_expiring`：ログインの期限（30日）が7日以内に切れる。`login` で更新する。

## してはいけないこと

- ログインで保存されたキー（`~/.config/cozeni/credentials.json`）を読まない。サイトのコード・`.env`・本番の環境変数にキーを書かない。本番のサイトはキーを使わない。
- 商品IDや購入リンクを推測で書かない。CLI の出力を使う。
- 利用者の同意なしに `--yes` を付けない。

## AGENTS.md への案内

```md
## Cozeni
購入・販売の設定や「買えない」などの問い合わせは、Cozeni の skill に従う。
最初に `npx @nulogic/cozeni-sdk status` で販売状態を確認する。推測で答えない。
```
