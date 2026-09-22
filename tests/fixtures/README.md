# 外部API v1の正式契約スナップショット

Cozeni外部API v1の公開仕様から取り込んだ固定fixtureです。SDKの実装ではなく、
API側の契約を正本とします。

- `external-api-v1.json`: 契約の正本スナップショット
- `openapi-external.json`: 同じ契約のOpenAPI文書。稼働中のAPIが
  `GET {API_ORIGIN}/external/v1/openapi.json`（認証不要）で返すものと同じ内容
- `external-api-v1.literal.ts`: 同じfixtureに `as const` を付けた型検査用表現。
  実行時テストでJSONとの完全一致を検査するため、型検査用だけを独立して変更できない

## 更新について

契約はCozeni側で定義され、このリポジトリはその写しを持つだけです。
**fixtureの更新はmaintainerがCozeni側の変更に合わせて行います。**
契約変更を伴う修正を外部から提案する場合は、先にIssueで相談してください。

JSONは整形だけを許容し、内容は取り込み時点の契約と同一です。
APIキーや有効な購入者JWTは含まれません。fixtureのexampleドメインは実接続先ではありません。
