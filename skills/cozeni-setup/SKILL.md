---
name: cozeni-setup
description: Cozeni導入プロンプトに従い、既存のJavaScriptサイトへ購入者認可をフレームワークに合わせて実装する。Next.js App Routerとその他のJavaScript / TypeScriptサーバー構成を判定し、対応する実装資料を案内する。
---

# Cozeniのフレームワーク実装

このskillは、Cozeni導入プロンプトで定められた接続、商品、購入リンク、秘密管理、検証、引き継ぎの共通契約を前提にする。ここでは、その契約を対象サイトのフレームワークへ組み込む方法だけを扱う。

## 構成を判定する

対象アプリの `AGENT.md` / `AGENTS.md`、`package.json`、lockfile、アプリ配置、既存の認証・ルーティング・サーバー実行境界を確認する。モノレポでは、導入対象のアプリを特定する。

- **Next.js App Router** を使う対象アプリは、[Next.js App Router](references/nextjs.md) に従う。
- それ以外の **JavaScript / TypeScriptサーバー構成** は、[JavaScript / TypeScriptサーバー](references/javascript-server.md) に従う。
- 静的SPAだけで限定コンテンツを保護する実装は成立しない。利用できるserverless function、Worker、SSRなどのサーバー境界が見つからない場合は、実装を止めて必要な構成を説明する。

既存の認証、middleware、ルーティングを置き換えず、判定した資料にある入口へ購入者認可を追加する。対象外のフレームワーク固有機能を推測して導入しない。
