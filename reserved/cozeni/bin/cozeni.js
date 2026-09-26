#!/usr/bin/env node
// 名前の乗っ取りを防ぐための予約パッケージ。CLI の処理は中継しない（SDK をプロジェクトに入れて使う前提）。
console.error(
  [
    'Cozeni の SDK がこのプロジェクトに入っていません。',
    '導入は `npx @nulogic/cozeni-sdk init --creator <cre_…> --json` から始めてください。',
    'The Cozeni SDK is not installed in this project. Start with `npx @nulogic/cozeni-sdk init`.',
  ].join('\n'),
);
process.exit(1);
