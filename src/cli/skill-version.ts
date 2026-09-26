// 利用者のプロジェクトに置かれたskillが、実行中のCLI（= SDK）の版に対応しているかを確かめる。
// skillのfrontmatterの`metadata.cozeni-sdk-version`に版の範囲（例: ">=0.5.0 <0.6.0"）を書く。
// ずれていても処理は止めず、警告だけ出す。
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { INIT_CLI } from "./invocation.js";

// `init`がコピーする場所（.agents・.claude）と、ほかのエージェントの場所、リポジトリ直下の`skills/`。
const locations = [
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".codex/skills",
  ".github/skills",
  ".windsurf/skills",
  "skills",
];

function parse(version: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1, 4).map(Number) : undefined;
}
function compare(a: number[], b: number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** 空白区切りの比較（>= > <= < =）をすべて満たすか。解釈できない範囲はundefined。 */
export function satisfies(version: string, range: string): boolean | undefined {
  // プレリリース等の付加部分は比較に使わない。
  const current = parse(version.split(/[-+]/)[0] ?? "");
  const conditions = range.trim().split(/\s+/).filter(Boolean);
  if (!current || conditions.length === 0) return undefined;
  for (const condition of conditions) {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(condition);
    const target = match ? parse(match[2] ?? "") : undefined;
    if (!match || !target) return undefined;
    const order = compare(current, target);
    const operator = match[1] ?? "=";
    const ok =
      operator === ">="
        ? order >= 0
        : operator === ">"
          ? order > 0
          : operator === "<="
            ? order <= 0
            : operator === "<"
              ? order < 0
              : order === 0;
    if (!ok) return false;
  }
  return true;
}

export function skillRange(text: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!frontmatter) return undefined;
  const match = /^\s+cozeni-sdk-version:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(
    frontmatter,
  );
  return match?.[1];
}

/** 対応しないskillがあれば警告文を返す。見つからない・読めない場合は何も返さない。 */
export async function skillVersionWarning(
  cwd: string,
  version: string,
): Promise<string | undefined> {
  for (const location of locations) {
    const path = join(cwd, location, "cozeni-setup", "SKILL.md");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const range = skillRange(text);
    if (range && satisfies(version, range) === false)
      return `警告: skill（${relative(cwd, path)}）の対応するSDKの版は ${range} ですが、実行中のCLIは ${version} です。${INIT_CLI} init で skill を更新してください（初めて init するプロジェクトでは --creator <クリエイターID> も付けます。IDは whoami で確かめられます）。`;
  }
  return undefined;
}
