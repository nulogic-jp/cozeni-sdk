// デバイスコード方式（RFC 8628）のログインとログアウト。
// AIエージェントのシェルはコマンドの終了まで出力を返さないことが多いため、
// 非対話では「コードを出してすぐ終了」→「--complete で承認を確かめる」の2段階にする。
import {
  CozeniError,
  failure,
  isLoopback,
  record,
  transport,
} from "../transport.js";
import {
  CLI,
  convert,
  type Profile,
  profileSuffix,
  TIMEOUT_MS,
} from "./api.js";
import { clientName } from "./environment.js";
import { CliError } from "./errors.js";
import type { Credential, Store } from "./store.js";

// 待ち状態の保存形式。デバイスコードは秘密として出力しない。
interface PendingLogin {
  version: 1;
  api_origin: string;
  app_origin: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_at: string;
  last_polled_at?: string;
}
export interface LoginContext {
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  version: string;
}
export interface Instructions {
  verification_uri: string;
  verification_uri_complete?: string;
  user_code: string;
  expires_at: string;
  next_step: string;
}

const COMPLETE_WAIT_MS = 90_000;
const pendingName = (profile: Profile) => `login-${profile.name}`;

function invalidResponse(): CliError {
  return new CliError(
    "invalid_response",
    "Cozeni から想定外の応答がありました。",
    {
      hint: `しばらく待ってから ${CLI} login をやり直してください。`,
    },
  );
}

/** 承認URLは、プロファイルの管理画面オリジンと一致するHTTPS（開発用はloopbackのHTTP）だけ採用する。 */
function trustedVerificationUrl(
  value: unknown,
  appOrigin: string,
): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url));
  if (
    !secure ||
    url.origin !== appOrigin ||
    url.username ||
    url.password ||
    url.hash
  )
    return undefined;
  return url.href;
}

function isPending(value: unknown): value is PendingLogin {
  return (
    record(value) &&
    value.version === 1 &&
    [
      "api_origin",
      "app_origin",
      "device_code",
      "user_code",
      "verification_uri",
      "expires_at",
    ].every((key) => typeof value[key] === "string") &&
    typeof value.interval === "number"
  );
}

function instructions(pending: PendingLogin, profile: Profile): Instructions {
  return {
    verification_uri: pending.verification_uri,
    ...(pending.verification_uri_complete
      ? { verification_uri_complete: pending.verification_uri_complete }
      : {}),
    user_code: pending.user_code,
    expires_at: pending.expires_at,
    next_step: `${CLI} login --complete${profileSuffix(profile)}`,
  };
}

function loginOrigins(
  profile: Profile,
  saved: Credential | undefined,
): { apiOrigin: string; appOrigin: string } {
  const apiOrigin = profile.apiOrigin ?? saved?.api_origin;
  const appOrigin = profile.appOrigin ?? saved?.app_origin;
  if (!apiOrigin || !appOrigin)
    throw new CliError(
      "invalid_input",
      `プロファイル ${profile.name} の接続先が決まっていません。`,
      {
        hint: "--api-origin と --app-origin で、APIと管理画面のオリジンを指定してください。",
      },
    );
  return { apiOrigin, appOrigin };
}

/** 第1段階。期限内の待ち状態があれば同じコードを出し直し、無ければ発行する。 */
export async function startLogin(
  context: LoginContext,
  store: Store,
  profile: Profile,
): Promise<{ pending: PendingLogin; instructions: Instructions }> {
  const { apiOrigin, appOrigin } = loginOrigins(
    profile,
    await store.loadCredential(profile.name),
  );
  const existing = await store.loadPending(pendingName(profile));
  if (
    isPending(existing) &&
    existing.api_origin === apiOrigin &&
    existing.app_origin === appOrigin &&
    Date.parse(existing.expires_at) > context.now()
  )
    return { pending: existing, instructions: instructions(existing, profile) };

  const send = transport({
    apiOrigin,
    fetch: context.fetch,
    timeoutMs: TIMEOUT_MS,
  });
  let data: unknown;
  try {
    const result = await send("/cli/device-codes", "POST", {
      cli_version: context.version,
      client_name: clientName(context.env),
    });
    if (!result.response.ok) throw failure(result.response, result.data);
    data = result.data;
  } catch (error) {
    throw convert(error, { apiOrigin, appOrigin, now: context.now() });
  }
  if (!record(data)) throw invalidResponse();
  const verification = trustedVerificationUrl(data.verification_uri, appOrigin);
  const expiresIn = data.expires_in;
  const interval = data.interval ?? 5;
  if (
    !verification ||
    typeof data.device_code !== "string" ||
    !/^[\x21-\x7E]{1,512}$/.test(data.device_code) ||
    typeof data.user_code !== "string" ||
    !/^[A-Z0-9-]{1,32}$/.test(data.user_code) ||
    typeof expiresIn !== "number" ||
    !Number.isInteger(expiresIn) ||
    expiresIn < 1 ||
    expiresIn > 3600 ||
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > 60
  )
    throw invalidResponse();
  const complete = trustedVerificationUrl(
    data.verification_uri_complete,
    appOrigin,
  );
  const pending: PendingLogin = {
    version: 1,
    api_origin: apiOrigin,
    app_origin: appOrigin,
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: verification,
    ...(complete ? { verification_uri_complete: complete } : {}),
    interval,
    expires_at: new Date(context.now() + expiresIn * 1000).toISOString(),
  };
  await store.savePending(pendingName(profile), pending);
  return { pending, instructions: instructions(pending, profile) };
}

export interface LoginResult {
  profile: string;
  api_origin: string;
  creator_id: string;
  environment: string;
  key_id: string;
  expires_at: string;
  credentials_path: string;
  warnings: string[];
}

function validToken(
  data: unknown,
): Omit<Credential, "api_origin" | "app_origin"> {
  if (
    !record(data) ||
    typeof data.api_key !== "string" ||
    !/^[\x21-\x7E]{1,512}$/.test(data.api_key) ||
    typeof data.key_id !== "string" ||
    !data.key_id ||
    data.key_id.length > 200 ||
    typeof data.creator_id !== "string" ||
    !data.creator_id ||
    data.creator_id.length > 200 ||
    typeof data.environment !== "string" ||
    !data.environment ||
    data.environment.length > 64 ||
    typeof data.expires_at !== "string" ||
    Number.isNaN(Date.parse(data.expires_at))
  )
    throw invalidResponse();
  return {
    api_key: data.api_key,
    key_id: data.key_id,
    creator_id: data.creator_id,
    environment: data.environment,
    expires_at: new Date(data.expires_at).toISOString(),
  };
}

/**
 * 第2段階。承認されるか、deadlineまでポーリングする。
 * deadlineを省略すると最長90秒で戻る（承認前なら終了コード6）。
 */
export async function completeLogin(
  context: LoginContext,
  store: Store,
  profile: Profile,
  options: { pending?: PendingLogin; deadline?: number } = {},
): Promise<LoginResult> {
  const name = pendingName(profile);
  const loaded = options.pending ?? (await store.loadPending(name));
  const retry = `${CLI} login${profileSuffix(profile)} からやり直してください。`;
  if (!isPending(loaded))
    throw new CliError(
      "login_required",
      "ログインの手続きが始まっていません。",
      {
        hint: `${CLI} login${profileSuffix(profile)} を実行してください。`,
      },
    );
  const pending: PendingLogin = { ...loaded };
  // 待ち状態の接続先と、いま指定されている接続先が違えばデバイスコードを送らない。
  if (
    (profile.apiOrigin !== undefined &&
      profile.apiOrigin !== pending.api_origin) ||
    (profile.appOrigin !== undefined &&
      profile.appOrigin !== pending.app_origin)
  )
    throw new CliError(
      "origin_mismatch",
      "ログインを始めたときと接続先が違います。",
      { hint: retry },
    );
  const expiresAt = Date.parse(pending.expires_at);
  const deadline = Math.min(
    options.deadline ?? context.now() + COMPLETE_WAIT_MS,
    expiresAt,
  );
  const expired = async () => {
    await store.removePending(name);
    return new CliError(
      "expired_token",
      "ログインのコードの期限が切れました。",
      {
        hint: retry,
      },
    );
  };
  const send = transport({
    apiOrigin: pending.api_origin,
    fetch: context.fetch,
    timeoutMs: TIMEOUT_MS,
  });
  let issued: Omit<Credential, "api_origin" | "app_origin"> | undefined;
  while (!issued) {
    const last = pending.last_polled_at
      ? Date.parse(pending.last_polled_at)
      : 0;
    const wait = Math.max(0, last + pending.interval * 1000 - context.now());
    if (context.now() + wait > deadline) {
      if (context.now() + wait >= expiresAt) throw await expired();
      throw new CliError("authorization_pending", "まだ承認されていません。", {
        hint: `利用者がブラウザで承認したら、${CLI} login --complete${profileSuffix(profile)} を再実行してください。`,
      });
    }
    if (wait > 0) await context.sleep(wait);
    pending.last_polled_at = new Date(context.now()).toISOString();
    // 別の起動がすぐにポーリングして間隔を破らないよう、時刻を保存しておく。
    await store.savePending(name, pending);
    try {
      const { response, data } = await send("/cli/tokens", "POST", {
        device_code: pending.device_code,
      });
      if (!response.ok) throw failure(response, data);
      issued = validToken(data);
    } catch (error) {
      if (
        error instanceof CozeniError &&
        error.code === "authorization_pending"
      )
        continue;
      if (error instanceof CozeniError && error.code === "slow_down") {
        // RFC 8628 §3.5: 以後の間隔を5秒延ばす。
        pending.interval += 5;
        await store.savePending(name, pending);
        continue;
      }
      if (error instanceof CozeniError && error.code === "access_denied") {
        await store.removePending(name);
        throw new CliError(
          "access_denied",
          "ログインは承認されませんでした。",
          {
            hint: retry,
          },
        );
      }
      if (error instanceof CozeniError && error.code === "expired_token")
        throw await expired();
      throw convert(error, {
        apiOrigin: pending.api_origin,
        appOrigin: pending.app_origin,
        now: context.now(),
      });
    }
  }

  const previous = await store.loadCredential(profile.name);
  const credential: Credential = {
    api_origin: pending.api_origin,
    app_origin: pending.app_origin,
    ...issued,
  };
  await store.saveCredential(profile.name, credential);
  await store.removePending(name);
  const warnings: string[] = [];
  // 前のキーは、新しいキーの保存が終わってから、そのキーを発行したオリジンで失効させる。
  if (previous && previous.api_key !== credential.api_key) {
    const revoked = await revoke(context, profile, previous);
    if (!revoked) warnings.push("previous_key_not_revoked");
  }
  // 環境変数のキーは保存したキーより優先されるため、ログインしても使われないことを知らせる。
  if (context.env.COZENI_API_KEY?.trim())
    warnings.push("env_key_takes_precedence");
  return {
    profile: profile.name,
    api_origin: credential.api_origin,
    creator_id: credential.creator_id,
    environment: credential.environment,
    key_id: credential.key_id,
    expires_at: credential.expires_at,
    credentials_path: store.credentialsPath,
    warnings,
  };
}

/** CLIのキーをサーバーで失効させる。失敗は呼び出し側が警告として扱う。 */
async function revoke(
  context: LoginContext,
  profile: Profile,
  credential: Credential,
): Promise<boolean> {
  // productionのキーは固定の接続先にしか送らない。書き換えられた保存ファイルに従わない。
  if (profile.production && credential.api_origin !== profile.apiOrigin)
    return false;
  try {
    const send = transport(
      {
        apiOrigin: credential.api_origin,
        fetch: context.fetch,
        timeoutMs: TIMEOUT_MS,
      },
      credential.api_key,
    );
    const { response } = await send("/cli/logout", "POST");
    return response.ok;
  } catch {
    return false;
  }
}

export interface LogoutResult {
  profile: string;
  removed: boolean;
  revoked: boolean;
  warnings: string[];
}

/** サーバーでの失効とローカルの削除を分け、ローカルの削除は必ず行う。 */
export async function logout(
  context: LoginContext,
  store: Store,
  profile: Profile,
): Promise<LogoutResult> {
  const warnings: string[] = [];
  const credential = await store.loadCredential(profile.name);
  let revoked = false;
  if (credential) {
    revoked = await revoke(context, profile, credential);
    if (!revoked) warnings.push("server_revoke_failed");
  }
  const removed = credential
    ? await store.removeCredential(profile.name)
    : false;
  await store.removePending(pendingName(profile));
  // 環境変数のキーは、管理画面で発行されサイトの運用で使われているものかもしれないため送らない。
  if (context.env.COZENI_API_KEY?.trim()) warnings.push("env_key_not_revoked");
  return { profile: profile.name, removed, revoked, warnings };
}
