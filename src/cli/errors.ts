// CLIの失敗を、終了コード・利用者向けの説明・次にやることの組で表す。
// 秘密（APIキー・デバイスコード）はmessageにもhintにも入れない。

const exitCodes: Record<string, number> = {
  invalid_input: 2,
  confirmation_required: 2,
  cancelled: 2,
  origin_mismatch: 2,
  login_required: 3,
  key_expired: 3,
  access_denied: 3,
  expired_token: 3,
  terms_consent_required: 4,
  forbidden: 4,
  not_found: 4,
  product_archived: 4,
  checkout_link_disabled: 4,
  idempotency_conflict: 4,
  creator_mismatch: 4,
  network_unreachable: 5,
  unexpected_redirect: 5,
  rate_limited: 5,
  unavailable: 5,
  authorization_pending: 6,
};

export class CliError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    options: { hint?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
  get exitCode(): number {
    return exitCodes[this.code] ?? 1;
  }
}
