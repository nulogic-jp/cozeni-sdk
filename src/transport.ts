// SDK本体（./index.ts）とCLI（./cli/）が共有する送信処理。
// package.jsonのexportsに載せない内部モジュールで、公開APIは./index.tsだけが持つ。

export interface ClientOptions {
  apiOrigin: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export interface ManagementClientOptions extends ClientOptions {
  apiKey: string;
}

const knownCodes = new Set([
  "invalid_input",
  "invalid_code",
  "unauthorized",
  "insufficient_scope",
  "terms_consent_required",
  "product_not_found",
  "checkout_link_not_found",
  "idempotency_conflict",
  "product_archived",
  "checkout_link_disabled",
  "rate_limited",
  "internal",
  "unavailable",
  "invalid_response",
  "network_error",
  "timeout",
  // 接続先が3xxを返した。APIキーを別の宛先へ送らないため追わずに止める。
  "unexpected_redirect",
  // CLIのデバイスコード方式（RFC 8628）のポーリング応答。
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
]);
export class CozeniError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  constructor(
    code: string,
    status = 0,
    requestId?: string,
    retryAfterSeconds?: number,
  ) {
    super(
      "Cozeniへの要求を完了できませんでした。codeとstatusを確認してください。",
    );
    this.name = "CozeniError";
    this.code = knownCodes.has(code) ? code : "invalid_response";
    this.status = status;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
function serverOnly() {
  if (typeof window !== "undefined") throw new CozeniError("invalid_input");
}
export function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
export function origin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CozeniError("invalid_input");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new CozeniError("invalid_input");
  return url;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export type Send = (
  path: string,
  method: string,
  body?: unknown,
  extra?: Record<string, string>,
) => Promise<{ response: Response; data: unknown }>;
export function transport(options: ClientOptions, apiKey?: string): Send {
  serverOnly();
  const base = origin(options.apiOrigin).origin;
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new CozeniError("invalid_input");
  const request = options.fetch ?? globalThis.fetch;
  return async (path, method, body, extra) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers({ Accept: "application/json", ...extra });
      if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const response = await request(`${base}/external/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        // リダイレクトは追わない。"error"だと通信障害と区別できないため、
        // "manual"で受けて3xx（ブラウザ互換実装ではopaqueredirect）を明示的に拒否する。
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
      });
      if (
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400)
      )
        throw new CozeniError("unexpected_redirect", response.status);
      // 本文を持たない成功応答（204）は、呼び出し側が本文を要求するかで判断する。
      if (response.status === 204) return { response, data: null };
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new CozeniError("invalid_response", response.status);
      }
      return { response, data };
    } catch (error) {
      if (error instanceof CozeniError) throw error;
      // fetchの例外やURLを保持しない。コード・JWT・APIキーのログ混入を防ぐ。
      throw new CozeniError(
        controller.signal.aborted ? "timeout" : "network_error",
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
export function failure(response: Response, data: unknown): CozeniError {
  // 外部APIの`{error: {code, request_id}}`に加え、RFC 8628の`{error: "<code>"}`も受ける。
  const error = record(data) && record(data.error) ? data.error : {};
  const code =
    typeof error.code === "string"
      ? error.code
      : record(data) && typeof data.error === "string"
        ? data.error
        : "invalid_response";
  const requestId =
    typeof error.request_id === "string" &&
    /^req_[a-zA-Z0-9_-]{1,96}$/.test(error.request_id)
      ? error.request_id
      : undefined;
  const retry = response.headers.get("Retry-After");
  return new CozeniError(
    code,
    response.status,
    requestId,
    retry && /^\d{1,8}$/.test(retry) ? Number(retry) : undefined,
  );
}
