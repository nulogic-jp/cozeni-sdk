/**
 * 公開リポジトリへ載る全ファイルを検査する。
 *
 * verify-package.mjs は npm pack の同梱物だけを見るため、tarballへ入らない
 * workflows・tests・fixtures・lockfileの混入を検出できない。公開リポジトリには
 * それらも載るので、git管理下の全テキストファイルへ同じ禁止パターンをかける。
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emailPattern,
  forbiddenContent,
  isAllowedExampleEmail,
} from "./forbidden-content.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// 検出器自身は禁止パターンを文字列として持つため、対象から外す。
const detectorFiles = new Set(["scripts/forbidden-content.mjs"]);

// GitHub Actionsは完全長SHAで固定する運用のため、その行だけは
// 「40桁のコミットSHA」検出の対象から外す。参照先は第三者の公開リポジトリで、
// 社内の情報を含まない。
const actionPin = /^\s*(?:-\s*)?uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40}\b/u;

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .filter((path) => !detectorFiles.has(path));

// git管理外で実行した場合などに、対象ゼロで成功と報告しないようにする。
if (tracked.length === 0) {
  console.error(
    "git管理下のファイルが見つかりません。リポジトリのルートで実行してください。",
  );
  process.exit(1);
}

const violations = [];
let scanned = 0;

for (const path of tracked) {
  const buffer = await readFile(join(root, path));
  // NULを含むものはバイナリとみなして本文検査の対象外にする。
  if (buffer.includes(0)) continue;
  scanned += 1;

  const lines = buffer.toString("utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (actionPin.test(line)) continue;
    const at = `${path}:${index + 1}`;

    for (const { label, pattern } of forbiddenContent) {
      pattern.lastIndex = 0;
      const found = line.match(pattern);
      if (found) violations.push(`${at}: ${label} (${found[0]})`);
    }

    emailPattern.lastIndex = 0;
    for (const [email] of line.matchAll(emailPattern)) {
      if (!isAllowedExampleEmail(email)) {
        violations.push(`${at}: example以外のメールアドレス (${email})`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("公開できない内容がリポジトリに含まれています:");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(
  `リポジトリ検証成功: ${tracked.length}ファイル（本文検査 ${scanned}件）/ 内部情報・秘密なし`,
);
