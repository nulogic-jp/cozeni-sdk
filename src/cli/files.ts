// ファイルの商品に付けるファイルの一覧・アップロード・削除。
// アップロードは手元のファイルをパートの大きさずつ読み、番号順に1つずつ送る（全体をメモリに読まない）。
import { open, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { DownloadableFile, UploadedPart } from "../index.js";
import { CozeniError, failure, record } from "../transport.js";
import { CLI, convert, profileSuffix, type Session } from "./api.js";
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
          hint: `先に ${CLI} products update <商品ID> --file-id <残すファイルID> … で商品から外すか、管理画面の商品の編集で外してください。`,
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

/** 手元のファイルの名前と大きさ（同じ内容の商品を探すため。上げる前の検査も兼ねる）。 */
export async function describeLocalFiles(
  cwd: string,
  paths: string[],
): Promise<{ filename: string; size_bytes: number }[]> {
  const files: { filename: string; size_bytes: number }[] = [];
  for (const path of paths) {
    const local = await localFile(cwd, path);
    files.push({ filename: local.filename, size_bytes: local.size });
  }
  return files;
}

/** 中断（Ctrl-C）されたことを表す。後続の完了・商品の作成へ進めない。 */
function interrupted(): CliError {
  return new CliError(
    "cancelled",
    "中断しました。途中のアップロードは取り消しました。",
  );
}

/**
 * 1回の要求を、429 は Retry-After だけ待って、一時的な障害は間隔を空けて送り直す。
 * 429 の待ちは障害の再試行とは別に数え、上限に達したらそのまま失敗にする。中断されたら送り直さない。
 */
async function withRetries<T>(
  request: () => Promise<T>,
  options: UploadOptions,
  isCancelled: () => boolean,
): Promise<T> {
  let attempt = 0;
  let rateLimitWaits = 0;
  for (;;) {
    if (isCancelled()) throw interrupted();
    try {
      return await request();
    } catch (error) {
      if (isCancelled()) throw interrupted();
      if (error instanceof CozeniError && error.code === "rate_limited") {
        // パートの送信もキー単位のレート制限に数えられる。速い回線で大きなファイルを送ると 429 になる。
        if (rateLimitWaits >= RATE_LIMIT_WAITS) throw error;
        rateLimitWaits += 1;
        await options.sleep(
          (error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000,
        );
        continue;
      }
      if (!retryable(error) || attempt >= PART_RETRIES) throw error;
      await options.sleep(1000 * 2 ** attempt);
      attempt += 1;
    }
  }
}

/** 完了の失敗のうち、サーバーで完了したかどうか分からないもの（通信の失敗・一時的な障害）。 */
function outcomeUnknown(error: unknown): boolean {
  return (
    error instanceof CozeniError &&
    (error.code === "network_error" ||
      error.code === "timeout" ||
      error.code === "rate_limited" ||
      error.code === "internal" ||
      error.code === "unavailable" ||
      error.code === "invalid_response")
  );
}

/**
 * 1ファイルを上げる。
 * - 手元のファイルはサーバーでアップロードを始める前に開く（開けなければ何も作らない）
 * - 中断（Ctrl-C）されたら、送信中のパートを止め、完了へ進まずにアップロードを取り消す
 * - 完了は冪等なので一時的な失敗では送り直す。完了したか分からないまま取り消さない
 */
async function uploadOne(
  session: Session,
  context: CommandContext,
  path: string,
  options: UploadOptions,
): Promise<DownloadableFile> {
  const local = await localFile(options.cwd, path);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(local.absolute, "r");
  } catch {
    throw new CliError("invalid_input", `ファイルを読めません: ${path}`, {
      hint: "パスとファイルの読み取り権限を確認してください。",
    });
  }
  try {
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
    // ここから先で失敗・中断したら、サーバーのアップロードを取り消す（完了したか分からないときを除く）。
    const controller = new AbortController();
    let cancelled = false;
    let discarding: Promise<void> | undefined;
    const discard = () =>
      (discarding ??= (async () => {
        try {
          await session.client.files.delete(started.id);
        } catch {
          // 後始末の失敗では元の失敗を隠さない。残ったものは files list で確かめて消せる。
        }
      })());
    const release = options.onInterrupt?.(async () => {
      cancelled = true;
      controller.abort();
      await discard();
    });
    const isCancelled = () => cancelled;
    let state: "uploading" | "completed" | "unknown" = "uploading";
    try {
      if (
        !Number.isInteger(started.part_size) ||
        started.part_size < 1 ||
        started.part_count !== Math.ceil(local.size / started.part_size)
      )
        throw new CliError(
          "invalid_response",
          "Cozeni から想定外の応答がありました。",
        );
      const send = session.send(PART_TIMEOUT_MS);
      const parts: UploadedPart[] = [];
      for (let number = 1; number <= started.part_count; number += 1) {
        if (cancelled) throw interrupted();
        const position = (number - 1) * started.part_size;
        let body: Uint8Array;
        try {
          body = await readPart(
            handle,
            position,
            Math.min(started.part_size, local.size - position),
          );
        } catch (error) {
          if (error instanceof CliError) throw error;
          throw new CliError("invalid_input", `ファイルを読めません: ${path}`, {
            hint: "アップロード中にファイルを動かしたり消したりしていないか確認し、もう一度実行してください。",
          });
        }
        const etag = await fileCall(
          session,
          context,
          () =>
            withRetries(
              async () => {
                const { response, data } = await send(
                  `/files/${encodeURIComponent(started.id)}/parts/${number}`,
                  "PUT",
                  body,
                  undefined,
                  controller.signal,
                );
                if (!response.ok) throw failure(response, data);
                if (!record(data) || typeof data.etag !== "string")
                  throw new CozeniError("invalid_response", response.status);
                return data.etag;
              },
              options,
              isCancelled,
            ),
          path,
        );
        parts.push({ part_number: number, etag });
        options.progress(
          `${local.filename}: ${Math.floor((number / started.part_count) * 100)}%（${number}/${started.part_count}）`,
        );
      }
      if (cancelled) throw interrupted();
      try {
        const file = await withRetries(
          async () => {
            const { response, data } = await send(
              `/files/${encodeURIComponent(started.id)}/complete`,
              "POST",
              { parts },
              undefined,
              controller.signal,
            );
            if (!response.ok) throw failure(response, data);
            if (!record(data) || typeof data.id !== "string")
              throw new CozeniError("invalid_response", response.status);
            return data as unknown as DownloadableFile;
          },
          options,
          isCancelled,
        );
        state = "completed";
        return file;
      } catch (error) {
        // 完了は冪等。送り直しても結果が分からないときは、上げ終えたデータを消さずに案内する。
        // 判定は利用者向けに変換する前の失敗で行う。
        if (!cancelled && outcomeUnknown(error)) {
          state = "unknown";
          throw new CliError(
            "unavailable",
            `${path}: アップロードの完了を確かめられませんでした。`,
            {
              hint: `${CLI} files list${profileSuffix(session.profile)} で ${started.id} の状態を確かめてください。アップロード済みならそのIDを --file-id で使えます。アップロード中のままなら ${CLI} files delete ${started.id} で消してから上げ直してください。`,
              details: { file_id: started.id },
            },
          );
        }
        throw convert(fileError(error, path), {
          apiOrigin: session.apiOrigin,
          appOrigin: session.appOrigin,
          session,
          now: context.now(),
        });
      }
    } finally {
      release?.();
      if (state === "uploading") await discard();
    }
  } finally {
    await handle.close();
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
      if (error instanceof CliError && files.length > 0) {
        const ids = files.map((file) => file.id);
        const kept = `先に上げ終えたファイルは残っています: ${ids.join(" ")}。商品に使うなら ${ids.map((id) => `--file-id ${id}`).join(" ")} を付け、要らなければ ${CLI} files delete <ファイルID> --yes で消してください。`;
        throw new CliError(error.code, error.message, {
          hint: error.hint ? `${error.hint}\n${kept}` : kept,
          details: {
            ...error.details,
            uploaded_file_ids: ids,
          },
        });
      }
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
