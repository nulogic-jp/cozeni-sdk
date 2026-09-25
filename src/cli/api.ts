// プロファイル（= 接続するCozeniの環境）の解決と、キーを発行時のオリジンに結ぶ処理、
// SDKのエラーを利用者向けの案内へ変換する処理。
import { createManagementClient } from "../index.js";
import { CozeniError, origin } from "../transport.js";
import { CliError } from "./errors.js";
import {
  type Config,
  type Credential,
  PROFILE_NAME,
  type Store,
} from "./store.js";

export const CLI = "npx @nulogic/cozeni-sdk";
export const PRODUCTION_API_ORIGIN = "https://api.cozeni.net";
export const PRODUCTION_APP_ORIGIN = "https://app.cozeni.net";
export const TIMEOUT_MS = 15000;
/** ログインの期限が近いとみなす残り時間。 */
export const KEY_EXPIRING_MS = 7 * 24 * 60 * 60 * 1000;

export interface Profile {
  name: string;
  production: boolean;
  // 明示的な指定（production以外のプロファイルでだけ受け付ける）。
  apiOrigin?: string;
  appOrigin?: string;
  /** init で覚えた、このプロファイルで使うはずのクリエイター。 */
  expectedCreatorId?: string;
  /** --profile を省略したときに選ばれるプロファイルか。 */
  isDefault: boolean;
}

/** 案内文に付けるプロファイル指定。既定のプロファイルでは何も付けない。 */
export function profileSuffix(profile: Profile): string {
  return profile.isDefault ? "" : ` --profile ${profile.name}`;
}

function normalized(value: string, label: string): string {
  try {
    return origin(value).origin;
  } catch {
    throw new CliError(
      "invalid_input",
      `${label} はオリジン（例: https://example.com）で指定してください。`,
    );
  }
}

/**
 * --profile を省略したら config.json の default_profile、無ければ production を使う。
 * production以外の接続先は、指定 → COZENI_API_ORIGIN → config.json の順に決める。
 */
export function resolveProfile(
  options: { profile?: string; "api-origin"?: string; "app-origin"?: string },
  env: Record<string, string | undefined>,
  config: Config = { version: 1, profiles: {} },
): Profile {
  const defaultName = config.default_profile ?? "production";
  const name = options.profile ?? defaultName;
  if (!PROFILE_NAME.test(name))
    throw new CliError(
      "invalid_input",
      "--profile は英小文字・数字・-・_ の32文字以内で指定してください。",
    );
  const saved = Object.hasOwn(config.profiles, name)
    ? config.profiles[name]
    : undefined;
  const common = {
    name,
    isDefault: name === defaultName,
    ...(saved?.expected_creator_id
      ? { expectedCreatorId: saved.expected_creator_id }
      : {}),
  };
  const api = options["api-origin"] ?? env.COZENI_API_ORIGIN;
  const app = options["app-origin"];
  if (name === "production") {
    // productionの接続先は固定する。同じ値の指定だけは受け付ける。
    if (
      (api !== undefined &&
        normalized(api, "接続先") !== PRODUCTION_API_ORIGIN) ||
      (app !== undefined &&
        normalized(app, "--app-origin") !== PRODUCTION_APP_ORIGIN)
    )
      throw new CliError(
        "invalid_input",
        "production プロファイルの接続先は変更できません。",
        {
          hint: "--api-origin / --app-origin / COZENI_API_ORIGIN を外してください。別の環境へ接続する場合は --profile で別のプロファイルを指定します。",
        },
      );
    return {
      ...common,
      production: true,
      apiOrigin: PRODUCTION_API_ORIGIN,
      appOrigin: PRODUCTION_APP_ORIGIN,
    };
  }
  return {
    ...common,
    production: false,
    apiOrigin:
      api === undefined
        ? saved?.api_origin
        : normalized(api, "--api-origin / COZENI_API_ORIGIN"),
    appOrigin:
      app === undefined ? saved?.app_origin : normalized(app, "--app-origin"),
  };
}

/**
 * 保存済みのキーを送ってよい接続先を返す。キーは保存時のapi_originにしか送らない。
 * productionは固定の接続先と一致しなければ、保存ファイルが書き換えられたものとみなす。
 */
export function boundOrigin(profile: Profile, credential: Credential): string {
  const saved = credential.api_origin;
  if (
    (profile.production && saved !== PRODUCTION_API_ORIGIN) ||
    (profile.apiOrigin !== undefined && profile.apiOrigin !== saved)
  )
    throw new CliError(
      "origin_mismatch",
      `保存済みのキーは ${saved} で発行されたもので、指定された接続先（${profile.apiOrigin}）へは送れません。`,
      {
        hint: `接続先の指定を外すか、${CLI} login${profileSuffix(profile)} で指定した接続先にログインし直してください。`,
      },
    );
  return saved;
}

export interface Session {
  profile: Profile;
  apiOrigin: string;
  appOrigin?: string;
  source: "env" | "saved";
  credential?: Credential;
  client: ReturnType<typeof createManagementClient>;
}

/** 管理APIを呼ぶためのキーを決める。COZENI_API_KEYは保存済みの認証情報より優先する。 */
export async function session(
  profile: Profile,
  store: Store,
  env: Record<string, string | undefined>,
  fetch: typeof globalThis.fetch,
  now: number,
): Promise<Session> {
  const envKey = env.COZENI_API_KEY?.trim();
  // 環境変数のキーで接続先も決まっているなら、保存ファイルを読まない
  // （壊れた・権限の緩い保存ファイルで、CIなどの実行が止まらないようにする）。
  const saved =
    envKey && profile.apiOrigin
      ? undefined
      : await store.loadCredential(profile.name);
  let apiOrigin: string;
  let apiKey: string;
  if (envKey) {
    // 環境変数のキーはプロファイルの接続先にだけ送る。
    const resolved = profile.apiOrigin ?? saved?.api_origin;
    if (!resolved)
      throw new CliError(
        "invalid_input",
        "COZENI_API_KEY を送る接続先が決まっていません。",
        { hint: "--api-origin で接続先を指定してください。" },
      );
    apiOrigin = resolved;
    apiKey = envKey;
  } else {
    if (!saved)
      throw new CliError("login_required", "Cozeni にログインしていません。", {
        hint: `${CLI} login${profileSuffix(profile)} を実行してください。`,
      });
    apiOrigin = boundOrigin(profile, saved);
    if (Date.parse(saved.expires_at) <= now) throw expired(profile);
    apiKey = saved.api_key;
  }
  const credential = envKey ? undefined : saved;
  const appOrigin = profile.appOrigin ?? saved?.app_origin;
  let client: Session["client"];
  try {
    client = createManagementClient({
      apiOrigin,
      apiKey,
      fetch,
      timeoutMs: TIMEOUT_MS,
    });
  } catch {
    throw new CliError("invalid_input", "APIキーの形式が正しくありません。", {
      hint: envKey
        ? "COZENI_API_KEY の値を確認してください。"
        : `${CLI} login${profileSuffix(profile)} を実行し直してください。`,
    });
  }
  return {
    profile,
    apiOrigin,
    appOrigin,
    source: envKey ? "env" : "saved",
    credential,
    client,
  };
}

/** 使うキーのクリエイターが、init で覚えたクリエイターと違う。 */
export function creatorMismatch(
  profile: Profile,
  actual: string,
  source: "login" | "saved" | "env",
): CliError {
  const expected = profile.expectedCreatorId ?? "";
  const login = `${CLI} login${profileSuffix(profile)}`;
  const text =
    source === "login"
      ? `別のアカウント（${actual}）で許可されました。この導入で使うアカウントは ${expected} です。`
      : `使おうとしたキーは別のアカウント（${actual}）のものです。この導入で使うアカウントは ${expected} です。`;
  const hint =
    source === "env"
      ? "環境変数 COZENI_API_KEY を外すか、正しいアカウントのキーに替えてから、同じコマンドを再実行してください。"
      : `ブラウザで Cozeni の正しいアカウント（${expected}）にログインし直してから、${login} からやり直してください。`;
  return new CliError("creator_mismatch", text, {
    hint,
    details: { expected_creator_id: expected, actual_creator_id: actual },
  });
}

/** 期待するクリエイターがあれば、使うキーのクリエイターと照合する。要求を送る前に呼ぶ。 */
export async function verifyCreator(
  current: Session,
  now: number,
): Promise<void> {
  const expected = current.profile.expectedCreatorId;
  if (!expected) return;
  let actual: string;
  if (current.credential) actual = current.credential.creator_id;
  else {
    try {
      actual = (await current.client.account.get()).creator_id;
    } catch (error) {
      throw convert(error, {
        apiOrigin: current.apiOrigin,
        appOrigin: current.appOrigin,
        session: current,
        now,
      });
    }
  }
  if (actual !== expected)
    throw creatorMismatch(current.profile, actual, current.source);
}

function expired(profile: Profile): CliError {
  return new CliError(
    "key_expired",
    "ログインの期限（30日）が切れました。セキュリティのため、月に1回確認をお願いしています。",
    { hint: `${CLI} login${profileSuffix(profile)} を実行してください。` },
  );
}

export function networkError(apiOrigin: string): CliError {
  const host = new URL(apiOrigin).hostname;
  return new CliError("network_unreachable", `${host} に接続できません。`, {
    hint: [
      "ネットワークの接続を確認してください。クラウドで動くAIツールは、既定で外部への通信が制限されています。",
      `- Codex cloud: 環境の設定でエージェントのインターネットアクセスを有効にし、許可するドメインに ${host} を追加する`,
      `- Claude Code on the web: 環境のネットワークアクセスを「カスタム」にし、許可するドメインに ${host} を追加する`,
      "設定を変えたら、同じコマンドを再実行してください。",
    ].join("\n"),
  });
}

/** SDKのエラーを、終了コードと案内を持つCLIのエラーへ変換する。 */
export function convert(
  error: unknown,
  context: {
    apiOrigin: string;
    appOrigin?: string;
    session?: Session;
    now: number;
  },
): CliError {
  if (error instanceof CliError) return error;
  if (!(error instanceof CozeniError))
    return new CliError("internal", "想定外のエラーで中断しました。");
  const details: Record<string, unknown> = {};
  if (error.requestId) details.request_id = error.requestId;
  const profile = context.session?.profile;
  const login = profile
    ? `${CLI} login${profileSuffix(profile)} を実行してください。`
    : `${CLI} login を実行してください。`;
  switch (error.code) {
    case "network_error":
    case "timeout":
      return networkError(context.apiOrigin);
    case "unexpected_redirect":
      return new CliError(
        "unexpected_redirect",
        "接続先がリダイレクトを返したため、キーを守るために中断しました。",
        {
          hint: "プロキシやネットワークの設定で、接続先への通信が別の場所へ転送されていないか確認してください。",
          details,
        },
      );
    case "unauthorized":
      if (context.session?.source === "env")
        return new CliError(
          "login_required",
          "COZENI_API_KEY のキーが無効か、期限が切れています。",
          {
            hint: `COZENI_API_KEY を環境変数から外して ${login}`,
            details,
          },
        );
      if (
        context.session?.credential &&
        Date.parse(context.session.credential.expires_at) <= context.now
      )
        return expired(context.session.profile);
      return new CliError(
        "login_required",
        "ログインが無効になりました（管理画面で失効された可能性があります）。",
        { hint: login, details },
      );
    case "terms_consent_required":
      return new CliError(
        "terms_consent_required",
        "Cozeni の利用規約が改定され、同意が必要です。",
        {
          hint: `${context.appOrigin ?? PRODUCTION_APP_ORIGIN} にログインし、改定された利用規約に同意してから、同じコマンドを再実行してください。`,
          details,
        },
      );
    case "insufficient_scope":
      return new CliError("forbidden", "このキーには必要な権限がありません。", {
        hint: login,
        details,
      });
    case "product_not_found":
    case "checkout_link_not_found":
      return new CliError("not_found", "指定した商品が見つかりません。", {
        hint: `${CLI} products list${profile ? profileSuffix(profile) : ""} で商品IDを確認してください。`,
        details,
      });
    case "product_archived":
      return new CliError(
        "product_archived",
        "この商品はアーカイブされています。",
        {
          hint: "管理画面で商品の状態を確認してください。",
          details,
        },
      );
    case "checkout_link_disabled":
      return new CliError(
        "checkout_link_disabled",
        "この商品の購入リンクは無効になっています。",
        { hint: "管理画面で購入リンクの状態を確認してください。", details },
      );
    case "idempotency_conflict":
      return new CliError(
        "idempotency_conflict",
        "同じ操作の再実行に、前回と異なる内容が含まれていました。",
        {
          hint: `${CLI} products list で商品が作られていないか確認してください。`,
          details,
        },
      );
    case "invalid_input":
      return new CliError(
        "invalid_input",
        "入力値が受け付けられませんでした。",
        {
          hint: "名前・価格・限定ページのURLを確認してください。",
          details,
        },
      );
    case "rate_limited": {
      const seconds = error.retryAfterSeconds;
      if (seconds !== undefined) details.retry_after_seconds = seconds;
      return new CliError(
        "rate_limited",
        "要求が多すぎるため、受け付けられませんでした。",
        {
          hint:
            seconds !== undefined
              ? `${seconds}秒後に同じコマンドを再実行してください。`
              : "しばらく待ってから同じコマンドを再実行してください。",
          details,
        },
      );
    }
    case "unavailable":
      return new CliError("unavailable", "Cozeni が一時的に利用できません。", {
        hint: "しばらく待ってから同じコマンドを再実行してください。",
        details,
      });
    case "internal":
      return new CliError("internal", "Cozeni 側でエラーが起きました。", {
        hint: "しばらく待ってから同じコマンドを再実行してください。",
        details,
      });
    default:
      return new CliError(
        "invalid_response",
        "Cozeni から想定外の応答がありました。",
        {
          details,
        },
      );
  }
}
