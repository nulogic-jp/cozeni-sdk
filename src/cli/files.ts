// ファイルの商品に付けるファイルの一覧・アップロード・削除。
// アップロードは手元のファイルをパートの大きさずつ読み、番号順に1つずつ送る（全体をメモリに読まない）。
import { open, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { DownloadableFile, UploadedPart } from "../index.js";
import { CozeniError, failure, record } from "../transport.js";
import { CLI, profileSuffix, type Session } from "./api.js";
import { type CommandContext, call, type Output } from "./commands.js";
import { CliError } from "./errors.js";

/** サーバーと同じ1ファイルの上限（2GiB）。超えるファイルは送る前に止める。 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** 1つの商品に付けられるファイルの数。 */
export const MAX_FILES_PER_PRODUCT = 20;
/** パート1つを送る時間の上限。10MiB を遅い回線で送っても切れないよう、通常の要求より長くする。 */
export const PART_TIMEOUT_MS = 120_000;
/** 失敗したパートを送り直す回数（最初の1回を含めない）。 */
const PART_RETRIES = 3;
/** 1パートで 429 を待つ上限の回数と、Retry-After が無いときの待ち秒数。 */
const RATE_LIMIT_WAITS = 10;
const DEFAULT_RETRY_AFTER_SECONDS = 10;

export interface UploadOptions {
  cwd: string;
  /** 進捗の1行（stderr に出す）。 */
  progress(line: string): void;
  sleep(ms: number): Promise<void>;
  /** 中断（Ctrl-C）のときに呼ぶ後始末を登録する。戻り値で登録を外す。 */
  onInterrupt?(cleanup: () => Promise<void>): () => void;
}

export function fileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${bytes} B`
    : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function fileLine(file: DownloadableFile): string {
  const states = [
    file.status === "uploading" ? "アップロード中" : null,
    file.disabled ? "配信停止中" : null,
    file.product_ids.length === 0 ? "どの商品にも付いていない" : null,
  ].filter((state): state is string => state !== null);
  return `- ${file.id} ${file.filename} ${fileSize(file.size_bytes)}${states.length ? `（${states.join("・")}）` : ""}`;
}

export async function listFiles(
  session: Session,
  context: CommandContext,
): Promise<Output> {
  const result = await call(session, context, () =>
    session.client.files.list(),
  );
  return {
    data: {
      files: result.data,
      used_bytes: result.used_bytes,
      limit_bytes: result.limit_bytes,
    },
    human: [
      ...(result.data.length === 0
        ? ["ファイルはありません。"]
        : result.data.map(fileLine)),
      `使用量: ${fileSize(result.used_bytes)} / ${fileSize(result.limit_bytes)}`,
    ],
  };
}

/** ファイルの API の失敗を、利用者向けの説明に変える。それ以外は共通の変換に任せる。 */
function fileError(error: unknown, path?: string): unknown {
  if (!(error instanceof CozeniError)) return error;
  const details = error.requestId ? { request_id: error.requestId } : {};
  const target = path ? `${path}: ` : "";
  switch (error.code) {
    case "file_too_large":
      return new CliError(
        "file_too_large",
        `${target}1ファイルは2GBまでです。`,
        { hint: "ファイルを分けるか、圧縮してから上げてください。", details },
      );
    case "storage_quota_exceeded":
      return new CliError(
        "storage_quota_exceeded",
        `${target}上げられるファイルの合計（20GB）を超えます。`,
        {
          hint: `${CLI} files list で使っていないファイルを確かめ、${CLI} files delete で消してください。`,
          details,
        },
      );
    case "file_not_found":
      return new CliError("not_found", "指定したファイルが見つかりません。", {
        hint: `${CLI} files list でファイルIDを確認してください。`,
        details,
      });
    case "file_in_use":
      return new CliError(
        "file_in_use",
        "商品に付いているファイルは消せません。",
        {
          hint: `先に ${CLI} products update で商品からファイルを外してください。`,
          details,
        },
      );
    default:
      return error;
  }
}

async function fileCall<T>(
  session: Session,
  context: CommandContext,
  request: () => Promise<T>,
  path?: string,
): Promise<T> {
  return call(session, context, async () => {
    try {
      return await request();
    } catch (error) {
      throw fileError(error, path);
    }
  });
}

/** 通信の失敗・一時的な障害だけ送り直す（入力の誤りは送り直しても直らない）。 */
function retryable(error: unknown): boolean {
  return (
    error instanceof CozeniError &&
    (error.code === "network_error" ||
      error.code === "timeout" ||
      error.code === "rate_limited" ||
      error.code === "internal" ||
      error.code === "unavailable")
  );
}

async function readPart(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      length - filled,
      position + filled,
    );
    if (bytesRead === 0)
      throw new CliError(
        "invalid_input",
        "アップロード中にファイルが短くなりました。",
        { hint: "ファイルを書き換えずに、もう一度実行してください。" },
      );
    filled += bytesRead;
  }
  return buffer;
}

/** 手元のファイルの大きさを確かめる。送る前に止められるものはここで止める。 */
async function localFile(cwd: string, path: string) {
  const absolute = resolve(cwd, path);
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    throw new CliError("invalid_input", `ファイルを読めません: ${path}`, {
      hint: "パスとファイルの読み取り権限を確認してください。",
    });
  }
  if (size === 0)
    throw new CliError(
      "invalid_input",
      `空のファイルは上げられません: ${path}`,
    );
  if (size > MAX_FILE_BYTES)
    throw new CliError("file_too_large", `${path}: 1ファイルは2GBまでです。`, {
      hint: "ファイルを分けるか、圧縮してから上げてください。",
    });
  return { absolute, size, filename: basename(absolute) };
}

/** 1ファイルを上げる。失敗・中断したらサーバーのアップロードを中止する（できる範囲で）。 */
async function uploadOne(
  session: Session,
  context: CommandContext,
  path: string,
  options: UploadOptions,
): Promise<DownloadableFile> {
  const local = await localFile(options.cwd, path);
  const started = await fileCall(
    session,
    context,
    () =>
      session.client.files.create({
        filename: local.filename,
        size_bytes: local.size,
      }),
    path,
  );
  if (
    !Number.isInteger(started.part_size) ||
    started.part_size < 1 ||
    started.part_count !== Math.ceil(local.size / started.part_size)
  )
    throw new CliError(
      "invalid_response",
      "Cozeni から想定外の応答がありました。",
    );
  const abort = async () => {
    try {
      await session.client.files.delete(started.id);
    } catch {
      // 後始末の失敗では元の失敗を隠さない。残ったものはサーバーが一定期間後に片づける。
    }
  };
  const release = options.onInterrupt?.(abort);
  const handle = await open(local.absolute, "r");
  let completed = false;
  try {
    const send = session.send(PART_TIMEOUT_MS);
    const parts: UploadedPart[] = [];
    for (let number = 1; number <= started.part_count; number += 1) {
      const position = (number - 1) * started.part_size;
      const body = await readPart(
        handle,
        position,
        Math.min(started.part_size, local.size - position),
      );
      const etag = await fileCall(
        session,
        context,
        async () => {
          let attempt = 0;
          let rateLimitWaits = 0;
          for (;;) {
            try {
              const { response, data } = await send(
                `/files/${encodeURIComponent(started.id)}/parts/${number}`,
                "PUT",
                body,
              );
              if (!response.ok) throw failure(response, data);
              if (!record(data) || typeof data.etag !== "string")
                throw new CozeniError("invalid_response", response.status);
              return data.etag;
            } catch (error) {
              // パートの送信もキー単位のレート制限に数えられる。速い回線で大きなファイルを送ると
              // 429 になるので、Retry-After だけ待って同じパートを送り直す（障害の再試行回数とは別に数える）。
              if (
                error instanceof CozeniError &&
                error.code === "rate_limited" &&
                rateLimitWaits < RATE_LIMIT_WAITS
              ) {
                rateLimitWaits += 1;
                await options.sleep(
                  (error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) *
                    1000,
                );
                continue;
              }
              if (!retryable(error) || attempt >= PART_RETRIES) throw error;
              await options.sleep(1000 * 2 ** attempt);
              attempt += 1;
            }
          }
        },
        path,
      );
      parts.push({ part_number: number, etag });
      options.progress(
        `${local.filename}: ${Math.floor((number / started.part_count) * 100)}%（${number}/${started.part_count}）`,
      );
    }
    const file = await fileCall(
      session,
      context,
      () => session.client.files.complete(started.id, parts),
      path,
    );
    completed = true;
    return file;
  } finally {
    await handle.close();
    release?.();
    if (!completed) await abort();
  }
}

/** ファイルを順に上げ、上げたファイルを返す。途中で失敗したら、それまでに上げたものは残す。 */
export async function uploadPaths(
  session: Session,
  context: CommandContext,
  paths: string[],
  options: UploadOptions,
): Promise<DownloadableFile[]> {
  if (paths.length === 0)
    throw new CliError("invalid_input", "上げるファイルを指定してください。");
  // 送る前に全部の大きさを確かめ、1つでも上げられないなら何も送らない。
  for (const path of paths) await localFile(options.cwd, path);
  const files: DownloadableFile[] = [];
  for (const path of paths) {
    try {
      files.push(await uploadOne(session, context, path, options));
    } catch (error) {
      // 先に上げ終えたファイルは残るので、IDを返して使い回せるようにする。
      if (error instanceof CliError && files.length > 0)
        throw new CliError(error.code, error.message, {
          hint: error.hint,
          details: {
            ...error.details,
            uploaded_file_ids: files.map((file) => file.id),
          },
        });
      throw error;
    }
  }
  return files;
}

export async function uploadFiles(
  session: Session,
  context: CommandContext,
  paths: string[],
  options: UploadOptions,
): Promise<Output> {
  const files = await uploadPaths(session, context, paths, options);
  return {
    data: { files, file_ids: files.map((file) => file.id) },
    human: [
      "ファイルを上げました:",
      ...files.map(fileLine),
      `商品を作るには: ${CLI} products create --name "<商品名>" --price <円> ${files.map((file) => `--file-id ${file.id}`).join(" ")}${profileSuffix(session.profile)}`,
    ],
  };
}

export async function deleteFile(
  session: Session,
  context: CommandContext,
  fileId: string,
): Promise<Output> {
  await context.confirm(`ファイル ${fileId} を削除します。元に戻せません。`, {
    action: "delete_file",
    file_id: fileId,
  });
  await fileCall(session, context, () => session.client.files.delete(fileId));
  return {
    data: { file_id: fileId, deleted: true },
    human: [`ファイルを削除しました: ${fileId}`],
  };
}
