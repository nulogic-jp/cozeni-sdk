import { randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SetupError, validateConfig } from "./setup.mjs";

const recovery = {
  setup_incomplete:
    "同じ設定・保存状態でsetup.mjs applyを完了してから再実行してください。",
  checkout_link_unusable:
    "保存された購入リンクを管理画面で確認し、同じ保存状態で導入を再開してください。",
  invalid_environment_value:
    "保存状態の接続値を確認してください。改行や環境変数の展開文字は使用できません。",
  invalid_config: "保存状態の所有者・環境を導入プロンプトと照合してください。",
  invalid_origin:
    "保存状態のAPI・自サイトoriginを確認してください。パス・認証情報・query・hashは指定できません。",
  insecure_production_origin:
    "本番環境のAPI・自サイトoriginをHTTPSにしてください。",
  invalid_product_id: "保存状態の既存商品IDを確認してください。",
  invalid_product:
    "保存状態の商品名・円価格・自サイト内のアクセス先を確認してください。",
};

export async function configureNext(statePath, envPath) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const config = validateConfig(state.config);
  if (
    state.phase !== "complete" ||
    typeof state.productId !== "string" ||
    !state.productId ||
    typeof state.checkoutUrl !== "string"
  )
    throw new SetupError("setup_incomplete");
  const checkout = new URL(state.checkoutUrl);
  if (
    !["https:", "http:"].includes(checkout.protocol) ||
    checkout.username ||
    checkout.password
  )
    throw new SetupError("checkout_link_unusable");
  const values = {
    COZENI_API_ORIGIN: config.apiOrigin,
    COZENI_SITE_ORIGIN: config.siteOrigin,
    COZENI_PRODUCT_ID: state.productId,
    COZENI_CHECKOUT_URL: checkout.href,
  };
  if (Object.values(values).some((value) => /[\r\n\0"`$\\]/.test(value)))
    throw new SetupError("invalid_environment_value");
  let original = "";
  try {
    original = await readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // 対象の非秘密変数だけを置換し、既存認証や秘密の行をそのまま保持する。
  const keys = new Set(Object.keys(values));
  const lines = original
    .split(/\r?\n/)
    .filter(
      (line) =>
        !keys.has(
          /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1],
        ),
    );
  while (lines.at(-1) === "") lines.pop();
  lines.push(
    ...Object.entries(values).map(([key, value]) => `${key}="${value}"`),
    "",
  );
  const temporary = `${envPath}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(lines.join("\n"));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, envPath);
  return Object.keys(values);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [statePath, envPath = ".env.local"] = process.argv.slice(2);
  if (!statePath) {
    process.stderr.write("状態ファイルのパスを指定してください。\n");
    process.exitCode = 1;
  } else
    configureNext(resolve(statePath), resolve(envPath))
      .then((keys) =>
        process.stdout.write(
          `非秘密の接続設定${keys.length}項目を保存しました。\n`,
        ),
      )
      .catch((error) => {
        // 入力、パス、未知例外の本文を含めず、既知の停止理由だけを表示する。
        const guidance =
          error instanceof SetupError && Object.hasOwn(recovery, error.code)
            ? `接続設定を保存できませんでした (${error.code})。${recovery[error.code]}保存状態は削除しないでください。\n`
            : "接続設定を保存できませんでした。状態ファイルと対象アプリを確認してください。\n";
        process.stderr.write(guidance);
        process.exitCode = 1;
      });
}
