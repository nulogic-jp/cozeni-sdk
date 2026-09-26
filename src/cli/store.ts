// CLIの認証情報と待ち状態を、利用者のホーム配下（プロジェクトの外）に保存する。
// 誤コミットと他ユーザーからの読み取りを防ぐため、ディレクトリ0700・ファイル0600とし、
// シンボリックリンクや緩い権限を見つけたら読み書きせずに止める。
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CliError } from "./errors.js";
import { CLI, INIT_CLI } from "./invocation.js";

export interface Credential {
  api_origin: string;
  app_origin: string;
  api_key: string;
  key_id: string;
  creator_id: string;
  environment: string;
  expires_at: string;
}
interface CredentialsFile {
  version: 1;
  profiles: Record<string, Credential>;
}

/** プロファイルごとの既定値。`init` が書き、以後のコマンドが読む。秘密は含めない。 */
export interface ProfileConfig {
  expected_creator_id?: string;
  // production以外の接続先。productionは固定のため保存しない。
  api_origin?: string;
  app_origin?: string;
}
export interface Config {
  version: 1;
  default_profile?: string;
  profiles: Record<string, ProfileConfig>;
}

export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const CREATOR_ID = /^cre_[A-Za-z0-9_-]{1,120}$/;

// Windowsは権限ビットで所有者限定を表せないため、権限の検査を行わない。
const checkModes = process.platform !== "win32";

export function configDirectory(env: Record<string, string | undefined>) {
  const xdg = env.XDG_CONFIG_HOME;
  // XDG Base Directory仕様に従い、相対パスは無視する。
  const base =
    xdg && isAbsolute(xdg) ? xdg : join(env.HOME || homedir(), ".config");
  return join(base, "cozeni");
}

function insecure(path: string, reason: string): CliError {
  return new CliError(
    "insecure_storage",
    `保存先 ${path} が安全ではないため、読み書きを中止しました（${reason}）。`,
    {
      hint: `${path} を確認し、シンボリックリンクなら削除、権限が広ければ chmod ${reason.includes("ディレクトリ") ? "700" : "600"} で所有者だけに絞ってください。`,
    },
  );
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    // 途中がシンボリックリンクのファイル等でmkdirが失敗した場合も安全でない扱いにする。
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw insecure(path, "ディレクトリを作成できません");
  }
  await checkDirectory(path);
}
async function checkDirectory(path: string): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw insecure(
      path,
      "ディレクトリがシンボリックリンクか通常のディレクトリではありません",
    );
  if (checkModes && (stats.mode & 0o077) !== 0)
    throw insecure(path, "ディレクトリの権限が0700より広い");
  if (
    checkModes &&
    typeof process.getuid === "function" &&
    stats.uid !== process.getuid()
  )
    throw insecure(path, "ディレクトリの所有者が実行ユーザーではありません");
  return true;
}
async function checkFile(path: string): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile())
    throw insecure(path, "シンボリックリンクか通常のファイルではありません");
  if (checkModes && (stats.mode & 0o077) !== 0)
    throw insecure(path, "権限が0600より広い");
  return true;
}

async function readJson(directory: string, path: string): Promise<unknown> {
  if (!(await checkDirectory(directory))) return undefined;
  if (!(await checkFile(path))) return undefined;
  let text: string;
  // lstatから開くまでの間の差し替えに備え、シンボリックリンクを追わずに開く。
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => {
    throw insecure(path, "シンボリックリンクか開けないファイルです");
  });
  try {
    const stats = await file.stat();
    if (checkModes && (stats.mode & 0o077) !== 0)
      throw insecure(path, "権限が0600より広い");
    text = await file.readFile("utf8");
  } finally {
    await file.close();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(
      "invalid_state",
      `保存ファイル ${path} を読み取れません。`,
      { hint: `${path} を削除してから、同じコマンドをやり直してください。` },
    );
  }
}

async function writeJson(
  directory: string,
  path: string,
  value: unknown,
): Promise<void> {
  // 書き込めない値は、ファイルに触れる前に失敗させる。
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await ensureDirectory(directory);
  await checkFile(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  // rename自体を永続化する。対応しない環境（Windows等）では省略する。
  const handle = await open(directory, "r").catch(() => undefined);
  if (handle) {
    try {
      await handle.sync().catch(() => {});
    } finally {
      await handle.close();
    }
  }
}

async function removeFile(directory: string, path: string): Promise<void> {
  if (!(await checkDirectory(directory))) return;
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return [
    "api_origin",
    "app_origin",
    "api_key",
    "key_id",
    "creator_id",
    "environment",
    "expires_at",
  ].every((key) => typeof entry[key] === "string");
}

export function createStore(env: Record<string, string | undefined>) {
  const directory = configDirectory(env);
  const credentialsPath = join(directory, "credentials.json");
  const pendingDirectory = join(directory, "pending");
  const pendingPath = (name: string) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(name))
      throw new CliError("invalid_input", "待ち状態の名前が不正です。");
    return join(pendingDirectory, `${name}.json`);
  };

  async function loadAll(): Promise<CredentialsFile> {
    const data = await readJson(directory, credentialsPath);
    if (data === undefined) return { version: 1, profiles: {} };
    const file = data as Partial<CredentialsFile>;
    if (
      file.version !== 1 ||
      typeof file.profiles !== "object" ||
      file.profiles === null
    )
      throw new CliError(
        "invalid_state",
        `保存ファイル ${credentialsPath} を読み取れません。`,
        {
          hint: `${credentialsPath} を削除してから、${CLI} login をやり直してください。`,
        },
      );
    return file as CredentialsFile;
  }

  const configPath = join(directory, "config.json");
  const invalidConfig = () =>
    new CliError(
      "invalid_state",
      `設定ファイル ${configPath} を読み取れません。`,
      {
        hint: `${configPath} を削除してから、${INIT_CLI} init をやり直してください。`,
      },
    );
  function isOrigin(value: unknown): boolean {
    if (typeof value !== "string") return false;
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  }

  return {
    directory,
    credentialsPath,
    configPath,
    async loadConfig(): Promise<Config> {
      const data = await readJson(directory, configPath);
      if (data === undefined) return { version: 1, profiles: {} };
      const file = data as Partial<Config>;
      if (
        file.version !== 1 ||
        typeof file.profiles !== "object" ||
        file.profiles === null ||
        Array.isArray(file.profiles) ||
        (file.default_profile !== undefined &&
          (typeof file.default_profile !== "string" ||
            !PROFILE_NAME.test(file.default_profile)))
      )
        throw invalidConfig();
      for (const [name, entry] of Object.entries(file.profiles)) {
        if (
          !PROFILE_NAME.test(name) ||
          typeof entry !== "object" ||
          entry === null ||
          (entry.expected_creator_id !== undefined &&
            (typeof entry.expected_creator_id !== "string" ||
              !CREATOR_ID.test(entry.expected_creator_id))) ||
          (entry.api_origin !== undefined && !isOrigin(entry.api_origin)) ||
          (entry.app_origin !== undefined && !isOrigin(entry.app_origin))
        )
          throw invalidConfig();
      }
      return file as Config;
    },
    async saveConfig(config: Config) {
      await writeJson(directory, configPath, config);
    },
    async loadCredential(profile: string): Promise<Credential | undefined> {
      const entry = (await loadAll()).profiles[profile];
      return isCredential(entry) ? entry : undefined;
    },
    async saveCredential(profile: string, credential: Credential) {
      const file = await loadAll();
      file.profiles[profile] = credential;
      await writeJson(directory, credentialsPath, file);
    },
    async removeCredential(profile: string): Promise<boolean> {
      const file = await loadAll();
      if (!(profile in file.profiles)) return false;
      delete file.profiles[profile];
      await writeJson(directory, credentialsPath, file);
      return true;
    },
    async loadPending(name: string): Promise<unknown> {
      const path = pendingPath(name);
      if (!(await checkDirectory(directory))) return undefined;
      return readJson(pendingDirectory, path);
    },
    async savePending(name: string, value: unknown) {
      const path = pendingPath(name);
      await ensureDirectory(directory);
      await writeJson(pendingDirectory, path, value);
    },
    /** 指定した接頭辞の待ち状態の名前を返す。 */
    async listPending(prefix: string): Promise<string[]> {
      if (!(await checkDirectory(directory))) return [];
      if (!(await checkDirectory(pendingDirectory))) return [];
      return (await readdir(pendingDirectory))
        .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
        .map((file) => file.slice(0, -".json".length))
        .filter((name) => /^[a-z0-9][a-z0-9_-]{0,127}$/.test(name));
    },
    async removePending(name: string) {
      const path = pendingPath(name);
      if (!(await checkDirectory(directory))) return;
      await removeFile(pendingDirectory, path);
    },
  };
}
export type Store = ReturnType<typeof createStore>;
