// `init`：導入の最初の1コマンド。通信はしない。
// 1. プロジェクトのルート（package.json のある場所）を決める
// 2. lockfile から package manager を決め、この版の SDK を通常の依存として入れる
// 3. 同梱の skill をプロジェクトへコピーする（シンボリックリンクにしない）
// 4. 既定のプロファイルと、期待するクリエイターを config.json に覚える
import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI, resolveProfile } from "./api.js";
import type { Output } from "./commands.js";
import { CliError } from "./errors.js";
import { CREATOR_ID, type Store } from "./store.js";

export const PACKAGE_NAME = "@nulogic/cozeni-sdk";

/** 子プロセスの実行。出力は受け取らない（トークン等を転記しないため）。 */
export type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
) => Promise<{ code: number | null; error?: string }>;

export interface InitContext {
  cwd: string;
  env: Record<string, string | undefined>;
  version: string;
  runCommand: RunCommand;
}
export interface InitOptions {
  creator?: string;
  profile?: string;
  "api-origin"?: string;
  "app-origin"?: string;
}

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";
// 同じディレクトリに複数あれば、先にあるものを使う。
const lockfiles: [string, PackageManager][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];
const installArgs: Record<PackageManager, string[]> = {
  bun: ["add", "--exact"],
  pnpm: ["add", "--save-exact"],
  yarn: ["add", "--exact"],
  npm: ["install", "--save-exact"],
};

const skillSource = fileURLToPath(
  new URL("../../skills/cozeni-setup/", import.meta.url),
);

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function findRoot(cwd: string): Promise<string> {
  let directory = cwd;
  for (;;) {
    if (await exists(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory)
      throw new CliError(
        "invalid_input",
        "package.json が見つからないため、どのサイトに入れるか決められません。",
        {
          hint: "サイトのプロジェクトのフォルダ（package.json のある場所）で、同じコマンドを実行してください。",
        },
      );
    directory = parent;
  }
}

/**
 * ルートから上へ、リポジトリの端（.git のある場所）まで見る。
 * ワークスペースでは lockfile と node_modules が上位にあることがあるため。
 */
async function upward(root: string): Promise<string[]> {
  const directories: string[] = [];
  let directory = root;
  for (;;) {
    directories.push(directory);
    if (await exists(join(directory, ".git"))) return directories;
    const parent = dirname(directory);
    if (parent === directory) return directories;
    directory = parent;
  }
}

const managers: PackageManager[] = ["bun", "pnpm", "yarn", "npm"];

/**
 * package.json の packageManager（例 "pnpm@9.1.0"）を lockfile より優先する。
 * 両方あって食い違えば、どちらが正しいか決められないため選ばずに止める。
 */
async function detectPackageManager(
  directories: string[],
): Promise<PackageManager> {
  let declared: PackageManager | undefined;
  for (const directory of directories) {
    const manifest = await readJsonFile(join(directory, "package.json"));
    const field =
      typeof manifest === "object" && manifest !== null
        ? (manifest as { packageManager?: unknown }).packageManager
        : undefined;
    if (typeof field !== "string") continue;
    const name = field.split("@")[0] as PackageManager;
    if (managers.includes(name)) declared = name;
    break;
  }
  let locked: { manager: PackageManager; file: string } | undefined;
  search: for (const directory of directories)
    for (const [file, manager] of lockfiles)
      if (await exists(join(directory, file))) {
        locked = { manager, file };
        break search;
      }
  if (declared && locked && declared !== locked.manager)
    throw new CliError(
      "package_manager_conflict",
      `package.json の packageManager は ${declared} ですが、lockfile（${locked.file}）は ${locked.manager} のものです。どちらで SDK を入れるか決められません。`,
      {
        hint: `このプロジェクトで使っている package manager を利用者に確かめ、packageManager か lockfile のどちらかに揃えてから、同じコマンドを再実行してください。`,
        details: { declared, lockfile: locked.file },
      },
    );
  return declared ?? locked?.manager ?? "npm";
}

/** 依存に書かれ、node_modules にこの版が入っていれば、入れ直さない。 */
async function alreadyInstalled(
  root: string,
  directories: string[],
  version: string,
): Promise<boolean> {
  const manifest = await readJsonFile(join(root, "package.json"));
  const dependencies =
    typeof manifest === "object" && manifest !== null
      ? (manifest as { dependencies?: Record<string, unknown> }).dependencies
      : undefined;
  if (typeof dependencies?.[PACKAGE_NAME] !== "string") return false;
  for (const directory of directories) {
    const installed = await readJsonFile(
      join(
        directory,
        "node_modules",
        ...PACKAGE_NAME.split("/"),
        "package.json",
      ),
    );
    if (installed !== undefined)
      return (installed as { version?: unknown }).version === version;
  }
  return false;
}

/**
 * package manager に渡す環境。Cozeni の変数（COZENI_API_KEY など）は、lifecycle script を
 * 含む子プロセスへ漏らさないよう外す。npm のトークン等は利用者の設定なので残す。
 */
export function childEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !key.toUpperCase().startsWith("COZENI_"),
    ),
  );
}

async function install(
  context: InitContext,
  root: string,
  manager: PackageManager,
): Promise<void> {
  const args = [...installArgs[manager], `${PACKAGE_NAME}@${context.version}`];
  const command = [manager, ...args].join(" ");
  let result: Awaited<ReturnType<RunCommand>>;
  try {
    result = await context.runCommand(
      manager,
      args,
      root,
      childEnvironment(context.env),
    );
  } catch {
    result = { code: null, error: "spawn_failed" };
  }
  if (result.code === 0) return;
  const missing = result.error === "ENOENT";
  throw new CliError(
    "install_failed",
    missing
      ? `${manager} が見つからないため、SDK を追加できませんでした。`
      : `SDK の追加（${command}）が失敗しました${result.code === null ? "" : `（終了コード ${result.code}）`}。`,
    {
      hint: missing
        ? `${manager} を使えるようにするか、このプロジェクトで使っている方法で ${PACKAGE_NAME}@${context.version} を依存に追加してから、同じコマンドを再実行してください。`
        : `${command} を実行して表示されたエラーを確かめ、直してから同じコマンドを再実行してください。`,
      details: {
        command,
        ...(result.code === null ? {} : { exit_code: result.code }),
      },
    },
  );
}

/** ディレクトリ内の通常ファイルを、相対パス → 内容 で返す。ディレクトリでなければ undefined。 */
async function readTree(
  directory: string,
): Promise<Map<string, Buffer> | undefined> {
  const tree = new Map<string, Buffer>();
  async function walk(path: string, prefix: string): Promise<void> {
    // シンボリックリンクはたどらない（Dirent は lstat の結果を表す）。
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), name);
      else if (entry.isFile())
        tree.set(name, await readFile(join(path, entry.name)));
    }
  }
  try {
    await walk(directory, "");
  } catch {
    return undefined;
  }
  return tree;
}

function sameTree(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, content] of a) {
    const other = b.get(path);
    if (!other?.equals(content)) return false;
  }
  return true;
}

type SkillStatus = "created" | "updated" | "unchanged";

function unsafePath(path: string, reason: string): CliError {
  return new CliError(
    "unsafe_path",
    `skill の置き場所 ${path} が安全ではないため、書き込みを中止しました（${reason}）。`,
    {
      hint: `${path} を確認し、シンボリックリンクなら通常のディレクトリに置き換えてから、同じコマンドを再実行してください。`,
    },
  );
}

/**
 * 配置先までの途中のディレクトリ（.agents・.agents/skills など）がシンボリックリンクや
 * ディレクトリ以外でないこと、実体がプロジェクトのルートの中にあることを確かめる。
 * 配置先そのもの（cozeni-setup）は置き換えの対象なので、ここでは見ない。
 */
async function checkTarget(root: string, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  for (let index = 1; index <= parts.length; index++) {
    const partial = parts.slice(0, index).join("/");
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(join(root, ...parts.slice(0, index)));
    } catch {
      return; // ここから先はまだ無い（作る）。
    }
    if (stats.isSymbolicLink())
      throw unsafePath(partial, "シンボリックリンクです");
    if (!stats.isDirectory())
      throw unsafePath(partial, "ディレクトリではありません");
  }
}
async function checkInsideRoot(root: string, directory: string, path: string) {
  const [realRoot, realDirectory] = await Promise.all([
    realpath(root),
    realpath(directory),
  ]);
  const inside = relative(realRoot, realDirectory);
  if (inside.startsWith("..") || isAbsolute(inside))
    throw unsafePath(path, "プロジェクトの外にあります");
}

/** 一時ディレクトリに書いてから差し替える。途中で失敗しても、既存の skill を壊さない。 */
async function placeSkill(
  source: Map<string, Buffer>,
  root: string,
  path: string,
): Promise<SkillStatus> {
  const target = join(root, ...path.split("/"));
  await checkTarget(root, path);
  const current = await readTree(target);
  if (current && sameTree(current, source)) return "unchanged";
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  // 作成と検査の間に差し替えられていないか、作ったあとで確かめ直す。
  await checkTarget(root, path);
  await checkInsideRoot(root, parent, path);
  const id = randomUUID();
  const temporary = join(parent, `.cozeni-setup-${id}.tmp`);
  const backup = join(parent, `.cozeni-setup-${id}.old`);
  try {
    for (const path of source.keys()) {
      const destination = join(temporary, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(skillSource, ...path.split("/")), destination);
    }
    let found = false;
    try {
      const stats = await lstat(target);
      found = true;
      // シンボリックリンクはリンクだけを外す（リンク先は消さない）。
      if (stats.isSymbolicLink()) await unlink(target);
      else await rename(target, backup);
    } catch (error) {
      if (found) throw error;
    }
    await rename(temporary, target);
    await rm(backup, { recursive: true, force: true });
    return found ? "updated" : "created";
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    // 退避したまま差し替えられなかったら、元に戻す。
    if ((await exists(backup)) && !(await exists(target)))
      await rename(backup, target).catch(() => {});
    throw error;
  }
}

async function skillTargets(
  context: InitContext,
  root: string,
): Promise<string[]> {
  const targets = [".agents/skills/cozeni-setup"];
  if (context.env.CLAUDECODE || (await exists(join(root, ".claude"))))
    targets.push(".claude/skills/cozeni-setup");
  // install などで何かを変える前に、置き場所の安全を確かめる。
  for (const path of targets) await checkTarget(root, path);
  return targets;
}

async function copySkills(
  root: string,
  targets: string[],
): Promise<{ path: string; status: SkillStatus }[]> {
  const source = await readTree(skillSource);
  if (!source?.has("SKILL.md"))
    throw new CliError("internal", "同梱の skill が見つかりません。");
  const results: { path: string; status: SkillStatus }[] = [];
  for (const path of targets)
    results.push({ path, status: await placeSkill(source, root, path) });
  return results;
}

export async function init(
  context: InitContext,
  store: Store,
  options: InitOptions,
): Promise<Output> {
  // 再実行で既定を変えないよう、--profile が無ければ今の既定を引き継ぐ。
  const config = await store.loadConfig();
  const name = options.profile ?? config.default_profile ?? "production";
  // production 以外の接続先は、指定が無ければ保存済みの値を使う。
  const profile = resolveProfile(
    { ...options, profile: name },
    context.env,
    config,
  );
  if (!profile.production && (!profile.apiOrigin || !profile.appOrigin))
    throw new CliError(
      "invalid_input",
      `プロファイル ${name} の接続先が指定されていません。`,
      {
        hint: "--api-origin と --app-origin で、APIと管理画面のオリジンを指定してください。",
      },
    );
  const saved = Object.hasOwn(config.profiles, name)
    ? config.profiles[name]
    : undefined;
  const creator = options.creator ?? saved?.expected_creator_id;
  if (!creator || !CREATOR_ID.test(creator))
    throw new CliError(
      "invalid_input",
      "--creator には、Cozeni の管理画面に表示されるクリエイターID（cre_ で始まる）を指定してください。",
    );

  const root = await findRoot(context.cwd);
  const directories = await upward(root);
  const manager = await detectPackageManager(directories);
  const targets = await skillTargets(context, root);
  const installed = !(await alreadyInstalled(
    root,
    directories,
    context.version,
  ));
  if (installed) await install(context, root, manager);
  const skills = await copySkills(root, targets);

  config.default_profile = name;
  config.profiles[name] = {
    expected_creator_id: creator,
    ...(profile.production
      ? {}
      : { api_origin: profile.apiOrigin, app_origin: profile.appOrigin }),
  };
  await store.saveConfig(config);

  // init したプロファイルが既定になるため、以後の案内に --profile は要らない。
  const nextStep = `${CLI} login`;
  const human = [
    "Cozeni の準備ができました。",
    installed
      ? `- 販売に使う部品（${PACKAGE_NAME} ${context.version}）をこのサイトに追加しました。`
      : `- 販売に使う部品（${PACKAGE_NAME} ${context.version}）は追加済みです。`,
    `- AI 向けの手順書を置きました: ${skills.map((skill) => skill.path).join("、")}`,
    `- 接続先: ${profile.production ? "本番" : name}（${profile.apiOrigin}）`,
    `- 使うアカウント: ${creator}`,
    `次にやること: ${nextStep} を実行して、Cozeni にログインします。`,
  ];
  return {
    data: {
      project_root: root,
      package_manager: manager,
      sdk: { name: PACKAGE_NAME, version: context.version, installed },
      skills,
      profile: name,
      api_origin: profile.apiOrigin,
      app_origin: profile.appOrigin,
      expected_creator_id: creator,
      config_path: store.configPath,
      next_step: nextStep,
    },
    human,
  };
}
