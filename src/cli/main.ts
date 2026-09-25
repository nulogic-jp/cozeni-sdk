#!/usr/bin/env node
// `cozeni` コマンドの実体。案内では `npx @nulogic/cozeni-sdk <コマンド>` で呼ぶ
// （スコープなしの名前は第三者が取得できるため、npxが別のパッケージを実行しうる）。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { run } from "./run.js";

function openBrowser(url: string) {
  // URLは管理画面オリジンとの一致を確認済み。シェルを介さず引数として渡す。
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args as string[], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ブラウザを開けなくても、表示したURLを利用者が開けばよい。
  }
}

/**
 * init の package manager を実行する。引数は固定の値だけで、利用者の入力を含まない。
 * 出力はトークン等を含みうるため、表示もせず受け取りもしない。
 */
function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; error?: string }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        cwd,
        stdio: "ignore",
        // Windowsの npm・pnpm・yarn は .cmd のため、シェル経由で起動する。
        shell: process.platform === "win32",
      });
      child.on("error", (error: NodeJS.ErrnoException) =>
        resolve({ code: null, error: error.code ?? "spawn_failed" }),
      );
      child.on("close", (code) => resolve({ code }));
    } catch {
      resolve({ code: null, error: "spawn_failed" });
    }
  });
}

let lines: ReturnType<typeof createInterface> | undefined;
function input() {
  lines ??= createInterface({ input: process.stdin });
  return lines;
}

const code = await run({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  interactiveTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  fetch: globalThis.fetch,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  openBrowser,
  prompt: (question) =>
    new Promise((resolve) => {
      process.stdout.write(question);
      input().once("line", resolve);
    }),
  onLine(listener) {
    const reader = input();
    reader.on("line", listener);
    return () => reader.off("line", listener);
  },
  runCommand,
});
lines?.close();
process.exitCode = code;
