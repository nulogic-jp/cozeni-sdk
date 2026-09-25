// 実行元の判定。AIエージェントのシェルはコマンドの終了まで出力を返さないことが多いため、
// 対話（承認を待って止まる・確認プロンプト）を使わない判定に使う。

// 名前は承認画面に「要求元」として表示される。秘密は含めない。
export function agentName(
  env: Record<string, string | undefined>,
): string | undefined {
  if (env.CLAUDECODE) return "Claude Code";
  if (env.CURSOR_AGENT) return "Cursor";
  if (Object.keys(env).some((key) => key.startsWith("CODEX_"))) return "Codex";
  if (env.GEMINI_CLI) return "Gemini CLI";
  return undefined;
}

export function clientName(env: Record<string, string | undefined>): string {
  return agentName(env) ?? (env.CI ? "CI" : "terminal");
}

/** TTYがあり、AIエージェントやCIの実行環境でなく、機械可読出力でもないとき対話する。 */
export function isInteractive(
  env: Record<string, string | undefined>,
  terminal: boolean,
  json: boolean,
): boolean {
  return terminal && !json && !agentName(env) && !env.CI;
}
