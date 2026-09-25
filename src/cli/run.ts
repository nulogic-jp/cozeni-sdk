// CLIの入口。引数の解釈・コマンドの振り分け・出力（人向け / --json）・終了コードを扱う。
// テストから入出力・時刻・通信を差し替えられるよう、実行環境はcontextで受け取る。
// Next.js専用の`/next`は読み込まない（server-onlyとnext/*に依存するため）。
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CLI, resolveProfile, session } from "./api.js";
import {
  type CommandContext,
  createProduct,
  link,
  listProducts,
  type Output,
  removeExpiredIdempotencyKeys,
  status,
  updateProduct,
  whoami,
} from "./commands.js";
import { isInteractive } from "./environment.js";
import { CliError } from "./errors.js";
import {
  completeLogin,
  type LoginContext,
  logout,
  startLogin,
} from "./login.js";
import { skillVersionWarning } from "./skill-version.js";
import { createStore } from "./store.js";

export interface CliContext {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  /** 標準入力と標準出力の両方がTTYか。 */
  interactiveTerminal: boolean;
  fetch: typeof globalThis.fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  openBrowser(url: string): void;
  prompt(question: string): Promise<string>;
  /** 標準入力の行入力（Enter）を受ける。戻り値で購読をやめる。 */
  onLine(listener: () => void): () => void;
}

export const version: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

const common = ["json", "profile", "api-origin", "app-origin", "help"];
const commands: Record<string, string[]> = {
  login: [...common, "complete"],
  logout: common,
  whoami: common,
  status: common,
  "products list": common,
  "products create": [...common, "yes", "name", "price", "access-url"],
  "products update": [...common, "yes", "name", "price", "access-url"],
  link: common,
};

const help = `Cozeni CLI ${version}

使い方: ${CLI} <コマンド> [オプション]

コマンド:
  login                     ログインを始める（承認用のURLとコードを表示）
  login --complete          承認を確かめてログインを終える
  logout                    ログインを終え、保存したキーを失効させる
  whoami                    接続先・クリエイター・ログインの期限を表示
  status                    販売できる状態か、次にやること、商品一覧を表示
  products list             商品一覧
  products create --name <名前> --price <円> --access-url <URL>
                            商品を作成し、購入リンクを返す（確認が必要）
  products update <商品ID> [--name] [--price] [--access-url]
                            商品を変更（価格・URLの変更は確認が必要）
  link <商品ID>             購入リンクを取得（無ければ発行）

共通オプション:
  --json                    AI向けの機械可読出力（1行のJSON）
  --yes                     確認を省略する（利用者に確認してから付ける）
  --profile <名前>          接続するCozeniの環境（既定: production）
  --help, --version
`;

function write(context: CliContext, json: boolean, output: Output) {
  if (json)
    context.stdout.write(
      `${JSON.stringify({ ok: true, data: output.data })}\n`,
    );
  else context.stdout.write(`${output.human.join("\n")}\n`);
}
function writeError(context: CliContext, json: boolean, error: CliError) {
  if (json) {
    context.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.hint ? { hint: error.hint } : {}),
          ...error.details,
        },
      })}\n`,
    );
    return;
  }
  context.stderr.write(
    `エラー: ${error.message}\n${error.hint ? `${error.hint}\n` : ""}`,
  );
}

type Flags = {
  json?: boolean;
  yes?: boolean;
  profile?: string;
  "api-origin"?: string;
  "app-origin"?: string;
  complete?: boolean;
  name?: string;
  price?: string;
  "access-url"?: string;
  help?: boolean;
  version?: boolean;
};

function parse(argv: string[]): { flags: Flags; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        yes: { type: "boolean" },
        profile: { type: "string" },
        "api-origin": { type: "string" },
        "app-origin": { type: "string" },
        complete: { type: "boolean" },
        name: { type: "string" },
        price: { type: "string" },
        "access-url": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    return { flags: values as Flags, positionals };
  } catch (error) {
    throw new CliError(
      "invalid_input",
      `引数を解釈できません: ${(error as Error).message}`,
      { hint: `${CLI} --help で使い方を確認してください。` },
    );
  }
}

export async function run(context: CliContext): Promise<number> {
  const json = context.argv.includes("--json");
  try {
    const { flags, positionals } = parse(context.argv);
    if (flags.version) {
      context.stdout.write(`${version}\n`);
      return 0;
    }
    const [first, second, ...rest] = positionals;
    const name =
      first === "products" && second !== undefined
        ? `${first} ${second}`
        : first;
    const args =
      first === "products"
        ? rest
        : [second, ...rest].filter(
            (value): value is string => value !== undefined,
          );
    if (flags.help || name === undefined || name === "help") {
      context.stdout.write(help);
      return 0;
    }
    const allowed = commands[name];
    if (!allowed)
      throw new CliError("invalid_input", `不明なコマンドです: ${name}`, {
        hint: `${CLI} --help で使い方を確認してください。`,
      });
    const unexpected = Object.keys(flags).filter(
      (key) => !allowed.includes(key),
    );
    if (unexpected.length > 0)
      throw new CliError(
        "invalid_input",
        `${name} では使えないオプションです: ${unexpected.map((key) => `--${key}`).join(" ")}`,
        { hint: `${CLI} --help で使い方を確認してください。` },
      );
    const needsId = name === "products update" || name === "link";
    if (needsId ? args.length !== 1 : args.length !== 0)
      throw new CliError(
        "invalid_input",
        needsId ? "商品IDを1つ指定してください。" : "余分な引数があります。",
        { hint: `${CLI} --help で使い方を確認してください。` },
      );

    const warning = await skillVersionWarning(context.cwd, version);
    if (warning) context.stderr.write(`${warning}\n`);

    const profile = resolveProfile(flags, context.env);
    const store = createStore(context.env);
    // 保存先に不備があっても、ここでは止めない（必要なコマンドがその場で報告する）。
    await removeExpiredIdempotencyKeys(store, context.now()).catch(() => {});
    const interactive = isInteractive(
      context.env,
      context.interactiveTerminal,
      json,
    );
    const loginContext: LoginContext = {
      env: context.env,
      fetch: context.fetch,
      now: context.now,
      sleep: context.sleep,
      version,
    };

    if (name === "login") {
      write(
        context,
        json,
        flags.complete
          ? loginOutput(await completeLogin(loginContext, store, profile))
          : interactive
            ? await interactiveLogin(context, loginContext, store, profile)
            : startOutput(await startLogin(loginContext, store, profile)),
      );
      return 0;
    }
    if (name === "logout") {
      const result = await logout(loginContext, store, profile);
      const human = [
        result.removed
          ? "ログアウトしました。保存していたキーを削除しました。"
          : "保存されたログインはありません。",
      ];
      if (result.warnings.includes("server_revoke_failed"))
        human.push(
          "注意: Cozeni 側でキーを失効できませんでした。管理画面のAPIキー一覧から失効させてください。",
        );
      if (result.warnings.includes("env_key_not_revoked"))
        human.push(
          "注意: 環境変数 COZENI_API_KEY のキーは失効させていません。使わない場合は環境変数から外してください。",
        );
      write(context, json, { data: { ...result }, human });
      return 0;
    }

    const commandContext: CommandContext = {
      now: context.now,
      async confirm(message, details) {
        if (flags.yes) return;
        if (!interactive)
          throw new CliError("confirmation_required", message, {
            hint: "利用者に内容を確認してから、--yes を付けて同じコマンドを実行してください。",
            // 何を確認するかは error.details にまとめる（request_id等の付加情報は error 直下）。
            details: { details },
          });
        const answer = await context.prompt(
          `${message}\nよろしいですか？ [y/N] `,
        );
        if (!/^y(es)?$/i.test(answer.trim()))
          throw new CliError("cancelled", "中止しました。");
      },
    };
    const current = await session(
      profile,
      store,
      context.env,
      context.fetch,
      context.now(),
    );
    const id = args[0] ?? "";
    const output =
      name === "whoami"
        ? await whoami(current, commandContext)
        : name === "status"
          ? await status(current, commandContext)
          : name === "products list"
            ? await listProducts(current, commandContext)
            : name === "products create"
              ? await createProduct(current, commandContext, store, flags)
              : name === "products update"
                ? await updateProduct(current, commandContext, id, flags)
                : await link(current, commandContext, id);
    write(context, json, output);
    return 0;
  } catch (error) {
    const failure =
      error instanceof CliError
        ? error
        : new CliError("internal", "想定外のエラーで中断しました。");
    writeError(context, json, failure);
    return failure.exitCode;
  }
}

function startOutput(result: Awaited<ReturnType<typeof startLogin>>): Output {
  const { instructions } = result;
  return {
    data: { ...instructions },
    human: [
      "次のURLをブラウザで開き、同じコードが表示されていることを確かめて承認してください。",
      `  URL: ${instructions.verification_uri_complete ?? instructions.verification_uri}`,
      `  コード: ${instructions.user_code}`,
      `  期限: ${instructions.expires_at}`,
      `承認したら次を実行します: ${instructions.next_step}`,
    ],
  };
}

function loginOutput(
  result: Awaited<ReturnType<typeof completeLogin>>,
): Output {
  const human = [
    `ログインしました（クリエイター: ${result.creator_id}、環境: ${result.environment}）。`,
    `ログインの有効期限: ${result.expires_at}（セキュリティのため30日ごとに確認をお願いしています）`,
    `認証情報は ${result.credentials_path} に平文で保存しました（所有者だけが読める権限です）。`,
  ];
  if (result.warnings.includes("previous_key_not_revoked"))
    human.push(
      "注意: 前のログインのキーを失効できませんでした。30日で自動的に無効になります。",
    );
  if (result.warnings.includes("env_key_takes_precedence"))
    human.push(
      "注意: 環境変数 COZENI_API_KEY が設定されているため、以後のコマンドはそちらのキーを使います。ログインしたキーを使うには環境変数から外してください。",
    );
  return { data: { ...result }, human };
}

/** TTYでは1段階で動く。コードを表示して承認を待ち、Enterでブラウザを開く。 */
async function interactiveLogin(
  context: CliContext,
  loginContext: LoginContext,
  store: ReturnType<typeof createStore>,
  profile: ReturnType<typeof resolveProfile>,
): Promise<Output> {
  const started = await startLogin(loginContext, store, profile);
  const { instructions } = started;
  const url =
    instructions.verification_uri_complete ?? instructions.verification_uri;
  context.stdout.write(
    [
      "Cozeni にログインします。",
      `1. ブラウザで次のURLを開いてください（Enterキーで開きます）: ${url}`,
      `2. 表示されたコードが ${instructions.user_code} と一致することを確かめて、承認してください。`,
      "承認を待っています…",
      "",
    ].join("\n"),
  );
  let opened = false;
  const stop = context.onLine(() => {
    if (opened) return;
    opened = true;
    context.openBrowser(url);
  });
  try {
    return loginOutput(
      await completeLogin(loginContext, store, profile, {
        pending: started.pending,
        deadline: Date.parse(started.pending.expires_at),
      }),
    );
  } finally {
    stop();
  }
}
