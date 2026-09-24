import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const scopes = [
  "products:read",
  "products:write",
  "checkout_links:read",
  "checkout_links:write",
];
const environments = ["development", "staging", "production"];
export class SetupError extends Error {
  constructor(code) {
    super(
      code === "unsupported_platform"
        ? "Cozeni導入を停止しました (unsupported_platform)。商品登録helperはmacOS/Linux専用です。WindowsではWSLのLinuxファイルシステム上で実行し、既存の保存状態を保持してください。"
        : `Cozeni導入を停止しました (${code})。保存状態を保持し、skillの復旧手順を確認してください。`,
    );
    this.code = code;
  }
}
const fail = (code) => {
  throw new SetupError(code);
};
function origin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("invalid_origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    fail("invalid_origin");
  return url.origin;
}
export function validateConfig(config) {
  if (
    !config ||
    typeof config !== "object" ||
    typeof config.creatorId !== "string" ||
    !config.creatorId ||
    !environments.includes(config.environment)
  )
    fail("invalid_config");
  const result = {
    creatorId: config.creatorId,
    environment: config.environment,
    apiOrigin: origin(config.apiOrigin),
    siteOrigin: origin(config.siteOrigin),
  };
  if (
    config.environment === "production" &&
    (!result.apiOrigin.startsWith("https:") ||
      !result.siteOrigin.startsWith("https:"))
  )
    fail("insecure_production_origin");
  if (config.existingProductId != null) {
    if (
      typeof config.existingProductId !== "string" ||
      !config.existingProductId
    )
      fail("invalid_product_id");
    result.existingProductId = config.existingProductId;
  }
  if (config.product != null) {
    const { name, price_jpy, access_url } = config.product;
    let access;
    try {
      access = new URL(access_url);
    } catch {
      fail("invalid_product");
    }
    if (
      typeof name !== "string" ||
      !name.trim() ||
      !Number.isInteger(price_jpy) ||
      price_jpy < 50 ||
      price_jpy > 9999999 ||
      access.origin !== result.siteOrigin ||
      access.username ||
      access.password ||
      access.search ||
      access.hash
    )
      fail("invalid_product");
    result.product = { name: name.trim(), price_jpy, access_url: access.href };
  }
  return result;
}
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function load(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("invalid_state");
  }
}
async function identity(client, config, writes) {
  const account = await client.account.get();
  if (
    account.creator_id !== config.creatorId ||
    account.environment !== config.environment ||
    account.api_version !== "v1"
  )
    fail("account_mismatch");
  const required = writes ? scopes : ["products:read"];
  if (!required.every((scope) => account.scopes.includes(scope)))
    fail("insufficient_scope");
  return account;
}
export async function inspectProducts({ config, client }) {
  config = validateConfig(config);
  const account = await identity(client, config, false);
  const products = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await client.products.list({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    products.push(...page.items);
    cursor = page.next_cursor;
    if (cursor && seen.has(cursor)) fail("invalid_pagination");
    seen.add(cursor);
  } while (cursor);
  // 販売可否（sales）は古いAPIバージョンでは返らないため、無ければnullで明示する。
  // APIキーや秘密は含まないため、そのまま出力に含めてよい。
  return { products, sales: account.sales ?? null };
}
export async function setupProduct({
  config,
  statePath,
  client,
  confirmed = false,
}) {
  // directory fsyncを省略せず、保証できない環境では状態書込とAPI呼出前に停止する。
  if (!["darwin", "linux"].includes(process.platform))
    fail("unsupported_platform");
  config = validateConfig(config);
  if (!confirmed) fail("confirmation_required");
  if (!config.product) fail("product_details_required");
  await mkdir(dirname(statePath), { recursive: true });
  let lock;
  try {
    lock = await open(`${statePath}.lock`, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") fail("setup_locked");
    throw error;
  }
  try {
    await identity(client, config, true);
    let state = await load(statePath);
    if (
      state &&
      (state.version !== 1 ||
        JSON.stringify(state.config) !== JSON.stringify(config))
    )
      fail("state_mismatch");
    if (
      state &&
      (typeof state.idempotencyKey !== "string" ||
        !state.idempotencyKey ||
        state.idempotencyKey.length > 128)
    )
      fail("invalid_state");
    if (!state) {
      state = {
        version: 1,
        config,
        idempotencyKey: randomUUID(),
        productId: config.existingProductId ?? null,
        checkoutUrl: null,
        phase: "prepared",
      };
      // 商品POSTより先に、確認済み入力と冪等キーを永続化する。
      await save(statePath, state);
    }
    if (!state.productId) {
      const created = await client.products.create(state.config.product, {
        idempotencyKey: state.idempotencyKey,
      });
      state.productId = created.id;
      state.phase = "product_saved";
      await save(statePath, state);
    }
    // 冪等応答は過去のスナップショットなので最新状態を取得する。
    const product = await client.products.get(state.productId);
    if (product.status !== "active") fail("product_archived");
    if (
      product.name !== config.product.name ||
      product.price_jpy !== config.product.price_jpy ||
      product.access_url !== config.product.access_url
    )
      fail("product_changed");
    let link;
    try {
      link = await client.checkoutLinks.get(state.productId);
    } catch (error) {
      if (error.status !== 404 || error.code !== "checkout_link_not_found")
        throw error;
      link = await client.checkoutLinks.ensure(state.productId);
    }
    if (link.disabled || link.product_id !== state.productId)
      fail("checkout_link_unusable");
    const checkout = new URL(link.url);
    if (
      !["https:", "http:"].includes(checkout.protocol) ||
      checkout.username ||
      checkout.password
    )
      fail("checkout_link_unusable");
    state.checkoutUrl = checkout.href;
    state.phase = "complete";
    await save(statePath, state);
    return state;
  } finally {
    await lock.close();
    await unlink(`${statePath}.lock`);
  }
}

async function main() {
  const [command, configFile, confirmation] = process.argv.slice(2);
  if (!["inspect", "apply"].includes(command) || !configFile)
    fail("usage_inspect_or_apply_config_json");
  if (!process.env.COZENI_API_KEY) fail("manual_server_key_required");
  const configPath = resolve(configFile);
  const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  // 対象プロジェクトへ導入された実SDKを解決する。秘密値は表示も保存もしない。
  const require = createRequire(resolve(process.cwd(), "package.json"));
  const { createManagementClient } = await import(
    pathToFileURL(require.resolve("@nulogic/cozeni-sdk")).href
  );
  const client = createManagementClient({
    apiOrigin: config.apiOrigin,
    apiKey: process.env.COZENI_API_KEY,
  });
  const output =
    command === "inspect"
      ? await inspectProducts({ config, client })
      : await setupProduct({
          config,
          statePath: resolve(dirname(configPath), "setup-state.json"),
          client,
          confirmed: confirmation === "--confirmed",
        });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    // API本文、URL、入力、スタックには秘密が混入しうるため出力しない。
    const allowed = new Set([
      "unauthorized",
      "insufficient_scope",
      "idempotency_conflict",
      "rate_limited",
      "unavailable",
      "product_not_found",
      "product_archived",
      "checkout_link_disabled",
    ]);
    const code =
      error instanceof SetupError || allowed.has(error.code)
        ? error.code
        : "setup_failed";
    process.stderr.write(`${new SetupError(code).message}\n`);
    process.exitCode = 1;
  });
}
