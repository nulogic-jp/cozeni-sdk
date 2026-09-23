---
name: cozeni-setup
description: Cozeni SDK（@nulogic/cozeni-sdk）を使う作業全般で使う。既存のJavaScript / TypeScriptサイトへの導入と購入者認可の実装、商品の作成・更新とチェックアウトリンクの発行、販売・購入できない原因の確認（inspectの sales）などを扱う。Next.js App Routerとその他のサーバー構成を判定し、対応する実装資料を案内する。
---

# Cozeni SDK

このskillは、Cozeni導入プロンプトで定められた接続、商品、購入リンク、秘密管理、検証、引き継ぎの共通契約を前提にする。商品の作成・更新とチェックアウトリンクの発行は商品登録helper（`scripts/setup.mjs`）で行い、呼び出し方法は導入プロンプトに従う。ここでは、その契約を対象サイトのフレームワークへ組み込む方法と、導入後の販売可否の確認を扱う。

## 構成を判定する

対象アプリの `AGENT.md` / `AGENTS.md`、`package.json`、lockfile、アプリ配置、既存の認証・ルーティング・サーバー実行境界を確認する。モノレポでは、導入対象のアプリを特定する。

- **Next.js App Router** を使う対象アプリは、[Next.js App Router](references/nextjs.md) に従う。
- それ以外の **JavaScript / TypeScriptサーバー構成** は、[JavaScript / TypeScriptサーバー](references/javascript-server.md) に従う。
- 静的SPAだけで限定コンテンツを保護する実装は成立しない。利用できるserverless function、Worker、SSRなどのサーバー境界が見つからない場合は、実装を止めて必要な構成を説明する。

既存の認証、middleware、ルーティングを置き換えず、判定した資料にある入口へ購入者認可を追加する。対象外のフレームワーク固有機能を推測して導入しない。

## 導入後に「購入できない」と相談されたら

まず商品登録helper（`scripts/setup.mjs`）の `inspect` コマンドを実行し、出力の `sales` を確認する。呼び出し方法（設定ファイルの場所やAPIキーの受け渡し）は導入プロンプトに従う。原因を推測で答えない。

- `sales` が `null`: 使用中のCozeni APIが `sales` に対応していない旧バージョンである。「Cozeni API側が古く、販売可否を取得できません」と伝え、原因を推測しない。
- `sales.can_sell` が `true` なのに購入できない: アカウントではなく商品単位の問題を疑う。`inspect` の `products` で対象商品の `status` を確認し、チェックアウトリンクが無効になっていないかはCozeniの管理画面で確認するよう利用者へ伝える。APIキーを使うコードを書いて調べない。
- `sales.can_sell` が `false`: `sales.blockers` の各項目を利用者へそのまま伝える。項目ごとの意味と利用者がすべき対応は次の表の通り。
- `sales.warnings` に `payouts_disabled` が含まれる場合: 販売はできるが入金が停止している旨を追加で伝える。

### blocker の code 一覧

| code | 意味 | 利用者がすること |
|---|---|---|
| `review_not_submitted` | 審査未申請 | `action_url` から審査を申請する |
| `review_pending` | 審査待ち | 審査完了を待つ（`action_url` で状況確認） |
| `review_rejected` | 審査の差し戻し | `rejection.reason_code` と `rejection.note` の指摘を直し、`action_url` から再申請する |
| `stripe_not_connected` | Stripe未接続 | `action_url` からStripeアカウントを接続する |
| `stripe_onboarding_incomplete` | Stripeの登録未完了 | `action_url` からStripeのオンボーディングを完了する |
| `stripe_verification_pending` | Stripeの本人確認待ち | Stripe側の確認完了を待つ（`action_url` で状況確認） |

`review_rejected` のときだけ `rejection` が必須で入る。`rejection.reason_code` の意味は次の通り。

| reason_code | 意味 |
|---|---|
| `tokushoho_missing_contact` | 特定商取引法に基づく連絡先情報が不足している |
| `tokushoho_unreachable` | 特定商取引法の連絡先に到達できない |
| `website_unreachable` | 販売サイトに到達できない |
| `description_insufficient` | 商品説明が不十分 |
| `prohibited_content` | 禁止されているコンテンツを含む |
| `other` | 上記以外（`note` を確認する） |

`rejection.note`（`string | null`）に補足があれば、そのまま利用者へ伝える。
