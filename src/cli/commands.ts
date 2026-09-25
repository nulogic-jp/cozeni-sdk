// ログイン後に使う管理コマンド（whoami / status / products / link）。
import { createHash, randomUUID } from "node:crypto";
import type {
  Account,
  CheckoutLink,
  Product,
  SalesBlocker,
  UpdateProduct,
} from "../index.js";
import { isLoopback, record } from "../transport.js";
import { CLI, convert, profileSuffix, type Session } from "./api.js";
import { CliError } from "./errors.js";
import type { Store } from "./store.js";

export interface CommandContext {
  now(): number;
  /** 作成・価格変更・access_urlの変更の前に呼ぶ。承諾されなければ例外を投げる。 */
  confirm(message: string, details: Record<string, unknown>): Promise<void>;
}
export interface Output {
  data: Record<string, unknown>;
  human: string[];
}

const yen = (value: number) => `${value.toLocaleString("ja-JP")}円`;
const KEY_EXPIRING_MS = 7 * 24 * 60 * 60 * 1000;

async function call<T>(
  session: Session,
  context: CommandContext,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw convert(error, {
      apiOrigin: session.apiOrigin,
      appOrigin: session.appOrigin,
      session,
      now: context.now(),
    });
  }
}

export async function whoami(
  session: Session,
  context: CommandContext,
): Promise<Output> {
  const account = await call(session, context, () =>
    session.client.account.get(),
  );
  const expiresAt = session.credential?.expires_at ?? null;
  return {
    data: {
      profile: session.profile.name,
      api_origin: session.apiOrigin,
      environment: account.environment,
      creator_id: account.creator_id,
      key_id: account.api_key_id,
      key_source: session.source,
      scopes: account.scopes,
      expires_at: expiresAt,
    },
    human: [
      `接続先: ${session.apiOrigin}（${account.environment}）`,
      `クリエイター: ${account.creator_id}`,
      `キー: ${account.api_key_id}（${session.source === "env" ? "環境変数 COZENI_API_KEY" : "ログインで保存したキー"}）`,
      ...(expiresAt ? [`ログインの有効期限: ${expiresAt}`] : []),
    ],
  };
}

async function allProducts(
  session: Session,
  context: CommandContext,
): Promise<Product[]> {
  const items: Product[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await call(session, context, () =>
      session.client.products.list({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!Array.isArray(result.items))
      throw new CliError("invalid_response", "商品一覧の形式が想定外です。");
    items.push(...result.items);
    if (!result.next_cursor) return items;
    if (seen.has(result.next_cursor)) break;
    seen.add(result.next_cursor);
    cursor = result.next_cursor;
  }
  throw new CliError(
    "invalid_response",
    "商品一覧のページをたどれませんでした。",
  );
}

function productLine(product: Product): string {
  return `- ${product.id} ${product.name} ${yen(product.price_jpy)} ${product.access_url}${product.status === "active" ? "" : `（${product.status}）`}`;
}

const blockerMessages: Record<SalesBlocker["code"], string> = {
  review_not_submitted: "審査を申請してください。",
  review_pending: "審査の完了を待ってください。",
  review_rejected: "審査で差し戻されました。指摘を直して再申請してください。",
  stripe_not_connected: "Stripeアカウントを接続してください。",
  stripe_onboarding_incomplete: "Stripeの登録を完了してください。",
  stripe_verification_pending: "Stripeの本人確認の完了を待ってください。",
};

export async function status(
  session: Session,
  context: CommandContext,
): Promise<Output> {
  const account: Account = await call(session, context, () =>
    session.client.account.get(),
  );
  const products = await allProducts(session, context);
  const sales = account.sales ?? null;
  const nextActions = (sales?.blockers ?? []).map((blocker) => ({
    code: blocker.code,
    action_url: blocker.action_url,
    message:
      blockerMessages[blocker.code] ?? "管理画面で状況を確認してください。",
    ...(blocker.code === "review_rejected"
      ? { rejection: blocker.rejection }
      : {}),
  }));
  const expiresAt = session.credential?.expires_at ?? null;
  const warnings: string[] = [];
  if (expiresAt && Date.parse(expiresAt) - context.now() < KEY_EXPIRING_MS)
    warnings.push("key_expiring");
  const human = [
    `接続先: ${session.apiOrigin}（${account.environment}）`,
    `クリエイター: ${account.creator_id}`,
    sales === null
      ? "販売: 接続先のAPIが販売状態の取得に対応していません。"
      : sales.can_sell
        ? "販売: できます。"
        : "販売: まだできません。",
  ];
  if (nextActions.length > 0) {
    human.push("次にやること:");
    for (const action of nextActions)
      human.push(`- ${action.message} ${action.action_url}`);
  }
  if (sales?.warnings.includes("payouts_disabled"))
    human.push("注意: 販売はできますが、売上の入金が停止しています。");
  human.push(`商品: ${products.length}件`);
  for (const product of products) human.push(productLine(product));
  if (expiresAt) human.push(`ログインの有効期限: ${expiresAt}`);
  if (warnings.includes("key_expiring"))
    human.push(
      `注意: ログインの期限が近づいています。${CLI} login${profileSuffix(session.profile)} で更新してください。`,
    );
  return {
    data: {
      profile: session.profile.name,
      api_origin: session.apiOrigin,
      environment: account.environment,
      creator_id: account.creator_id,
      key: {
        id: account.api_key_id,
        source: session.source,
        expires_at: expiresAt,
      },
      sales,
      next_actions: nextActions,
      products,
      warnings,
    },
    human,
  };
}

export async function listProducts(
  session: Session,
  context: CommandContext,
): Promise<Output> {
  const items = await allProducts(session, context);
  return {
    data: { items },
    human:
      items.length === 0 ? ["商品はまだありません。"] : items.map(productLine),
  };
}

function checkoutLink(link: CheckoutLink): CheckoutLink {
  let url: URL | undefined;
  try {
    url = new URL(link.url);
  } catch {
    url = undefined;
  }
  if (
    !record(link) ||
    !url ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopback(url))
    ) ||
    url.username ||
    url.password
  )
    throw new CliError("invalid_response", "購入リンクの形式が想定外です。");
  if (link.disabled)
    throw new CliError(
      "checkout_link_disabled",
      "この商品の購入リンクは無効になっています。",
      { hint: "管理画面で購入リンクの状態を確認してください。" },
    );
  return {
    id: link.id,
    product_id: link.product_id,
    url: url.href,
    disabled: link.disabled,
  };
}

export async function link(
  session: Session,
  context: CommandContext,
  productId: string,
): Promise<Output> {
  const result = checkoutLink(
    await call(session, context, () =>
      session.client.checkoutLinks.ensure(productId),
    ),
  );
  return {
    data: { checkout_link: result },
    human: [`購入リンク: ${result.url}`],
  };
}

export interface ProductInput {
  name?: string;
  price?: string;
  "access-url"?: string;
}
function parsePrice(value: string): number {
  if (!/^\d{1,9}$/.test(value))
    throw new CliError(
      "invalid_input",
      "--price は円の整数で指定してください。",
    );
  return Number(value);
}
function parseName(value: string): string {
  const name = value.trim();
  if (!name) throw new CliError("invalid_input", "--name を指定してください。");
  return name;
}
function parseAccessUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(
      "invalid_input",
      "--access-url は購入者に見せるページのURL（https://…）で指定してください。",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new CliError(
      "invalid_input",
      "--access-url は購入者に見せるページのURL（https://…）で指定してください。",
    );
  return url.href;
}

export async function createProduct(
  session: Session,
  context: CommandContext,
  store: Store,
  input: ProductInput,
): Promise<Output> {
  if (
    input.name === undefined ||
    input.price === undefined ||
    !input["access-url"]
  )
    throw new CliError(
      "invalid_input",
      "--name・--price・--access-url をすべて指定してください。",
    );
  const product = {
    name: parseName(input.name),
    price_jpy: parsePrice(input.price),
    access_url: parseAccessUrl(input["access-url"]),
  };
  await context.confirm(
    `商品「${product.name}」を ${yen(product.price_jpy)} で作成します。購入後に表示するページ: ${product.access_url}`,
    { action: "create", product },
  );
  const account = await call(session, context, () =>
    session.client.account.get(),
  );
  // タイムアウト後の再実行で商品が二重にならないよう、入力ごとの冪等キーを送信前に保存する。
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        session.profile.name,
        account.creator_id,
        product.name,
        product.price_jpy,
        product.access_url,
      ]),
    )
    .digest("hex");
  const pendingName = `idem-${hash}`;
  const saved = await store.loadPending(pendingName);
  let idempotencyKey: string;
  if (
    record(saved) &&
    typeof saved.idempotency_key === "string" &&
    /^[\x21-\x7E]{1,128}$/.test(saved.idempotency_key)
  )
    idempotencyKey = saved.idempotency_key;
  else {
    idempotencyKey = randomUUID();
    await store.savePending(pendingName, {
      version: 1,
      idempotency_key: idempotencyKey,
      created_at: new Date(context.now()).toISOString(),
    });
  }
  const created = await call(session, context, () =>
    session.client.products.create(product, { idempotencyKey }),
  );
  const result = checkoutLink(
    await call(session, context, () =>
      session.client.checkoutLinks.ensure(created.id),
    ),
  );
  // 商品とリンクの両方がそろってから消す。途中で失敗しても、再実行で同じ商品に戻れる。
  await store.removePending(pendingName);
  return {
    data: { product: created, checkout_link: result },
    human: [
      `商品を作成しました: ${created.name}（${yen(created.price_jpy)}）`,
      `商品ID: ${created.id}`,
      `購入リンク: ${result.url}`,
    ],
  };
}

export async function updateProduct(
  session: Session,
  context: CommandContext,
  productId: string,
  input: ProductInput,
): Promise<Output> {
  const update: UpdateProduct = {};
  if (input.name !== undefined) update.name = parseName(input.name);
  if (input.price !== undefined) update.price_jpy = parsePrice(input.price);
  if (input["access-url"] !== undefined)
    update.access_url = parseAccessUrl(input["access-url"]);
  if (Object.keys(update).length === 0)
    throw new CliError(
      "invalid_input",
      "変更する項目（--name・--price・--access-url）を指定してください。",
    );
  const current = await call(session, context, () =>
    session.client.products.get(productId),
  );
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const messages: string[] = [];
  if (
    update.price_jpy !== undefined &&
    update.price_jpy !== current.price_jpy
  ) {
    changes.price_jpy = { from: current.price_jpy, to: update.price_jpy };
    messages.push(
      `価格を ${yen(current.price_jpy)} から ${yen(update.price_jpy)} に変更します。`,
    );
  }
  if (
    update.access_url !== undefined &&
    update.access_url !== current.access_url
  ) {
    changes.access_url = { from: current.access_url, to: update.access_url };
    messages.push(
      `購入後に表示するページを ${current.access_url} から ${update.access_url} に変更します。既存の購入者全員に、すぐに反映されます。`,
    );
  }
  if (messages.length > 0)
    await context.confirm(messages.join("\n"), {
      action: "update",
      product_id: productId,
      changes,
    });
  const updated = await call(session, context, () =>
    session.client.products.update(productId, update),
  );
  return {
    data: { product: updated },
    human: [
      `商品を更新しました: ${updated.name}（${yen(updated.price_jpy)}）`,
      `購入後に表示するページ: ${updated.access_url}`,
    ],
  };
}
