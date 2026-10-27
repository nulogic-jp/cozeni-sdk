// ログイン後に使う管理コマンド（whoami / status / products / link）。
import { createHash, randomUUID } from "node:crypto";
import {
  type Account,
  type AccountSales,
  type CheckoutLink,
  CozeniError,
  type CreateProduct,
  type FeatureFlagMetadata,
  type Product,
  type SalesBlocker,
  type UpdateProduct,
} from "../index.js";
import { isLoopback, record } from "../transport.js";
import {
  CLI,
  convert,
  KEY_EXPIRING_MS,
  profileSuffix,
  type Session,
} from "./api.js";
import { CliError } from "./errors.js";
import {
  describeLocalFiles,
  fileSize,
  MAX_FILES_PER_PRODUCT,
  type UploadOptions,
  uploadPaths,
} from "./files.js";
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
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export async function call<T>(
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
      expected_creator_id: session.profile.expectedCreatorId ?? null,
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

/** 機能フラグの設定値を `k=v, …` で並べる。無ければ「設定値なし」。 */
function metadataText(metadata: FeatureFlagMetadata | undefined): string {
  const entries = Object.entries(metadata ?? {});
  return entries.length === 0
    ? "設定値なし"
    : entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

const featureLabel = (metadata: FeatureFlagMetadata | undefined) =>
  `機能フラグ（設定値: ${metadataText(metadata)}）`;

function productKind(product: Product): string {
  if (product.access_type === "feature") return featureLabel(product.metadata);
  if (product.access_type === "file")
    return product.files ? `ファイル（${product.files.length}件）` : "ファイル";
  return String(product.access_url);
}

function productLine(product: Product): string {
  return `- ${product.id} ${product.name} ${yen(product.price_jpy)} ${productKind(product)}${product.status === "active" ? "" : `（${product.status}）`}`;
}

const blockerMessages: Record<SalesBlocker["code"], string> = {
  review_not_submitted: "販売者の情報を申請してください。",
  review_pending: "販売者の情報の審査が終わるのを待ってください。",
  review_rejected:
    "販売者の情報の申請が差し戻されました。指摘を直して申請し直してください。",
  stripe_not_connected: "売上の受け取り先を登録してください。",
  stripe_onboarding_incomplete:
    "売上の受け取り先の登録が途中です。続きから入力してください。",
  stripe_verification_pending:
    "売上の受け取り先の確認が終わるのを待ってください。",
};

// サンドボックスでは、売上の受け取り先（Stripe）の登録は本番と同じ画面でテスト用の値を入れて行う（V-21）。
// 画面全体の「テストデータを使う」ボタンは無く、テスト用のボタンは銀行口座と本人確認の画面ごとにある（V-29 の実測）。
// 名前・住所などそのほかの入力値は導入プロンプトの「売上の受け取り先のテスト登録」に書いてあるので、ここでは複製せず参照する（V-29）。
// 名前の「サンドボックス」は登録をお願いするときに1回だけ出し、以後は「テスト」と呼ぶ（V-25）。
// 利用者には決済事業者名を出さず、管理画面と同じ「売上の受け取り先」と呼ぶ。
const SANDBOX_STRIPE_SCREEN =
  "決済サービスの画面では、銀行口座は「テストアカウントを使用する」、本人確認は「シミュレーション」→「確認成功」→「結果を送信する」を使い、SMS のコードを聞かれたら 000-000 を入力";
/** 利用者に見せる手順（message_for_user・next_actions）。 */
const SANDBOX_STRIPE_STEPS = `${SANDBOX_STRIPE_SCREEN}してください。そのほかの入力値は、導入プロンプトの「売上の受け取り先のテスト登録」に従ってください。`;
/** AI への指示（next_step・error.hint）の丸かっこ内に入れる、利用者への頼み方。 */
export const SANDBOX_STRIPE_REQUEST = `${SANDBOX_STRIPE_SCREEN}する。そのほかの入力値は、導入プロンプトの「売上の受け取り先のテスト登録」の値を伝える`;
const sandboxBlockerMessages: Partial<Record<SalesBlocker["code"], string>> = {
  stripe_not_connected: `テスト用に、売上の受け取り先を登録してください。${SANDBOX_STRIPE_STEPS}`,
  stripe_onboarding_incomplete: `テスト用の売上の受け取り先の登録が途中です。続きから入力してください。${SANDBOX_STRIPE_STEPS}`,
  stripe_verification_pending:
    "テスト用の売上の受け取り先の確認が終わるのを待ってください。",
};

/** 機能フラグのテスト購入のあと、返金が済むまで残す印（接頭辞 idem- ではないので期限切れの掃除で消えない）。 */
export const testPurchaseMark = (profileName: string, productId: string) =>
  `test-purchase-${profileName}-${productId}`.toLowerCase();

/** 返金していない機能フラグのテスト購入の商品ID。プロファイル名が別のプロファイルの接頭辞でも混ざらないよう、印の名前を照合する。 */
export async function unrefundedTestPurchases(
  store: Store,
  profileName: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const name of await store.listPending(
    testPurchaseMark(profileName, ""),
  )) {
    try {
      const saved = await store.loadPending(name);
      if (
        record(saved) &&
        typeof saved.product_id === "string" &&
        name === testPurchaseMark(profileName, saved.product_id)
      )
        ids.push(saved.product_id);
    } catch {
      // 読めない印は数えない。1件の不備で status を止めない。
    }
  }
  return ids.sort();
}

export async function status(
  session: Session,
  context: CommandContext,
  store: Store,
): Promise<Output> {
  const account: Account = await call(session, context, () =>
    session.client.account.get(),
  );
  const products = await allProducts(session, context);
  const sales = account.sales ?? null;
  const sandbox = account.environment === "sandbox";
  const nextActions = (sales?.blockers ?? []).map((blocker) => ({
    code: blocker.code,
    action_url: blocker.action_url,
    message:
      (sandbox ? sandboxBlockerMessages[blocker.code] : undefined) ??
      blockerMessages[blocker.code] ??
      "管理画面で状況を確認してください。",
    ...(blocker.code === "review_rejected"
      ? { rejection: blocker.rejection }
      : {}),
  }));
  const expiresAt = session.credential?.expires_at ?? null;
  const warnings: string[] = [];
  if (expiresAt && Date.parse(expiresAt) - context.now() < KEY_EXPIRING_MS)
    warnings.push("key_expiring");
  const unrefunded = await unrefundedTestPurchases(store, session.profile.name);
  if (unrefunded.length > 0) warnings.push("test_purchase_not_refunded");
  const messageForUser = userMessages(sales, nextActions, session.appOrigin);
  const human = [
    `接続先: ${session.apiOrigin}（${account.environment}）`,
    `クリエイター: ${account.creator_id}`,
    sales === null
      ? "販売: 接続先のAPIが販売状態の取得に対応していません。"
      : sales.can_sell
        ? "販売: できます。"
        : "販売: まだできません。",
    ...messageForUser,
  ];
  human.push(`商品: ${products.length}件`);
  for (const product of products) human.push(productLine(product));
  if (expiresAt) human.push(`ログインの有効期限: ${expiresAt}`);
  if (unrefunded.length > 0)
    human.push(
      `返金していないテスト購入があります: ${unrefunded.join(", ")}。${CLI} test-purchase --product ${unrefunded[0]} --refund${profileSuffix(session.profile)} --json で返金してください。`,
    );
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
      expected_creator_id: session.profile.expectedCreatorId ?? null,
      key: {
        id: account.api_key_id,
        source: session.source,
        expires_at: expiresAt,
      },
      sales,
      next_actions: nextActions,
      message_for_user: messageForUser,
      products,
      warnings,
      unrefunded_test_purchases: unrefunded,
      next_step: statusNextStep(session, sandbox, nextActions, products),
    },
    human,
  };
}

/** 次に打つコマンド。サンドボックスで売上の受け取り先の登録が未完了なら、利用者への依頼を AI への指示として返す（V-21）。 */
function statusNextStep(
  session: Session,
  sandbox: boolean,
  actions: { code: string; action_url: string }[],
  products: Product[],
): string | null {
  const create = `${CLI} products create --name "<商品名>" --price <円> --access-url "<URL>"${profileSuffix(session.profile)}`;
  const hasProduct = products.some((product) => product.status === "active");
  const stripe = actions.filter(
    (action) =>
      action.code === "stripe_not_connected" ||
      action.code === "stripe_onboarding_incomplete",
  );
  if (sandbox && stripe.length > 0)
    return [
      `商品名・価格・限定にするページの確認と同じ1通で、利用者に売上の受け取り先のテスト登録を頼みます（${SANDBOX_STRIPE_REQUEST}）。案内するURL: ${stripe.map((action) => action.action_url).join(" ")}`,
      `登録の完了を待たずに、商品の作成とサイトへの組み込みを進めます。\`${CLI} test-purchase\` の前に、もう一度 \`${CLI} status --json\` で登録が済んだか（sales.can_sell）を確かめます。`,
      ...(hasProduct ? [] : [`商品は \`${create}\` で作ります。`]),
    ].join("\n");
  return hasProduct ? null : create;
}

/** 利用者にそのまま見せられる「次にやること」。AI が言い換えずに伝えられるよう、ここで文を作る。 */
function userMessages(
  sales: AccountSales | null,
  actions: {
    message: string;
    action_url: string;
    rejection?: { note: string | null };
  }[],
  appOrigin: string | undefined,
): string[] {
  if (sales === null)
    return [
      `販売できる状態かを確かめられませんでした。Cozeni の管理画面で確認してください。${appOrigin ? ` ${appOrigin}` : ""}`,
    ];
  const lines: string[] = [];
  if (actions.length > 0) {
    lines.push("販売を始めるには、次の手続きが必要です。");
    actions.forEach((action, index) => {
      const note = action.rejection?.note;
      const message = note
        ? `${action.message.replace(/。$/, "")}（理由: ${note}）。`
        : action.message;
      lines.push(`${index + 1}. ${message} ${action.action_url}`);
    });
  } else if (sales.can_sell) lines.push("すぐ販売できます。");
  if (sales.warnings.includes("payouts_disabled"))
    lines.push(
      "販売はできますが、売上の入金が止まっています。売上の受け取り先の登録内容を確認してください。",
    );
  return lines;
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

function checkoutLink(
  link: CheckoutLink,
  options: { allowDisabled?: boolean } = {},
): CheckoutLink {
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
  if (link.disabled && !options.allowDisabled)
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

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/** 発行済みの購入リンクを取得する。未発行なら null（発行はしない）。 */
async function existingLink(
  session: Session,
  context: CommandContext,
  productId: string,
): Promise<CheckoutLink | null> {
  const found = await call(session, context, async () => {
    try {
      return await session.client.checkoutLinks.get(productId);
    } catch (error) {
      if (
        error instanceof CozeniError &&
        error.code === "checkout_link_not_found"
      )
        return null;
      throw error;
    }
  });
  return found ? checkoutLink(found, { allowDisabled: true }) : null;
}

/** 商品1件と購入リンクを表示する。リンクは取得だけで、未発行でも発行しない（発行は link）。 */
export async function getProduct(
  session: Session,
  context: CommandContext,
  productId: string,
): Promise<Output> {
  const product = await call(session, context, () =>
    session.client.products.get(productId),
  );
  const result = await existingLink(session, context, product.id);
  return {
    data: {
      product,
      checkout_link: result,
      next_step:
        result === null
          ? `${CLI} link ${product.id}${profileSuffix(session.profile)}`
          : null,
    },
    human: [
      productLine(product),
      ...(product.files ?? []).map(
        (file) =>
          `  - ${file.id} ${file.filename} ${fileSize(file.size_bytes)}${file.disabled ? "（配信停止中）" : ""}`,
      ),
      result === null
        ? `購入リンク: 未発行（${CLI} link ${product.id} で発行できます）`
        : `購入リンク: ${result.url}${result.disabled ? "（無効）" : ""}`,
    ],
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
  "allow-duplicate"?: boolean;
  feature?: boolean;
  metadata?: string[];
  /** 上げてから付ける手元のファイル。 */
  file?: string[];
  /** 上げ済みのファイルのID。 */
  "file-id"?: string[];
}
// サーバーが受け付ける価格の範囲（円）。
const MIN_PRICE = 50;
const MAX_PRICE = 9_999_999;
function parsePrice(value: string): number {
  if (
    !/^\d{1,9}$/.test(value) ||
    Number(value) < MIN_PRICE ||
    Number(value) > MAX_PRICE
  )
    throw new CliError(
      "invalid_input",
      `--price は ${yen(MIN_PRICE)} から ${yen(MAX_PRICE)} までの整数（円）で指定してください。`,
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

const METADATA_VALUE_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;
/** `--metadata key=value` を設定値にする。true/false は真偽値、数の形は数値、それ以外は文字列。 */
export function parseMetadata(values: string[]): FeatureFlagMetadata {
  const metadata: FeatureFlagMetadata = {};
  for (const item of values) {
    const separator = item.indexOf("=");
    const key = separator < 0 ? "" : item.slice(0, separator);
    if (separator < 0 || key === "")
      throw new CliError(
        "invalid_input",
        `--metadata は key=value の形で指定してください: ${item}`,
      );
    if (key === "__proto__")
      throw new CliError(
        "invalid_input",
        "--metadata のキーに __proto__ は使えません。",
      );
    if (Object.hasOwn(metadata, key))
      throw new CliError(
        "invalid_input",
        `--metadata のキーが重複しています: ${key}`,
      );
    const raw = item.slice(separator + 1);
    metadata[key] =
      raw === "true"
        ? true
        : raw === "false"
          ? false
          : METADATA_VALUE_NUMBER.test(raw)
            ? Number(raw)
            : raw;
  }
  return metadata;
}

function sameMetadata(a: FeatureFlagMetadata, b: FeatureFlagMetadata) {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}

/** 機能フラグの商品を作ったあと、利用者に頼むキーの発行の案内（キーの値は含まない）。 */
function featureKeyRequest(session: Session, sandbox: boolean): string {
  const place = session.appOrigin
    ? `${session.appOrigin}/settings/developer`
    : "Cozeni の開発者設定";
  return `利用者に、${place} で、権限「購入画面を作る」「購入者の機能フラグを確かめる」の API キーの発行を頼みます。キーは利用者が環境変数 COZENI_API_KEY に入れます（手元の開発ではローカルの .env.local、本番では本番の環境変数）。${sandbox ? "サンドボックスのキーなので COZENI_ENVIRONMENT=sandbox も同じ場所に入れます。" : ""}キーの値は読まない・表示しない。`;
}

export async function createProduct(
  session: Session,
  context: CommandContext,
  store: Store,
  input: ProductInput,
  upload?: UploadOptions,
): Promise<Output> {
  if (input.name === undefined || input.price === undefined)
    throw new CliError(
      "invalid_input",
      "--name・--price と、--access-url・--feature・--file（--file-id）のどれかを指定してください。",
    );
  const feature = input.feature === true;
  const paths = input.file ?? [];
  const givenIds = input["file-id"] ?? [];
  const file = paths.length > 0 || givenIds.length > 0;
  if (
    [feature, Boolean(input["access-url"]), file].filter(Boolean).length !== 1
  )
    throw new CliError(
      "invalid_input",
      "--access-url（購入後に見せるページ）・--feature（機能フラグ）・--file / --file-id（ファイル）のどれか1つを指定してください。",
    );
  if (!feature && input.metadata !== undefined)
    throw new CliError(
      "invalid_input",
      "--metadata は --feature のときだけ指定できます。",
    );
  if (file) {
    if (paths.length + givenIds.length > MAX_FILES_PER_PRODUCT)
      throw new CliError(
        "invalid_input",
        `1つの商品に付けられるファイルは${MAX_FILES_PER_PRODUCT}件までです。`,
      );
    if (new Set(givenIds).size !== givenIds.length)
      throw new CliError("invalid_input", "--file-id が重複しています。");
  }
  const name = parseName(input.name);
  const priceJpy = parsePrice(input.price);
  const metadata = feature ? parseMetadata(input.metadata ?? []) : {};
  const accessUrlInput = input["access-url"];
  const accessUrl = accessUrlInput ? parseAccessUrl(accessUrlInput) : undefined;
  // 機能フラグの案内（サンドボックスか）と冪等キーのために、接続先のアカウントを1度だけ取る。
  let account: Account | undefined;
  const getAccount = async () =>
    (account ??= await call(session, context, () =>
      session.client.account.get(),
    ));
  // 導入のやり直しで同じ商品が増えないよう、作る前に同じ内容の有効な商品を探す。
  // 見つかれば作らず（確認も要らない）、それを返す。購入リンクは取得だけで、発行しない。
  // 手元のファイルは上げるたびにIDが変わるので、ファイル名と大きさで照合する
  // （導入のやり直しで、同じファイルを上げ直して商品を増やさないため）。
  if (!input["allow-duplicate"]) {
    const local =
      paths.length > 0 && upload
        ? await describeLocalFiles(upload.cwd, paths)
        : [];
    const sameFiles = (
      files: { id: string; filename: string; size_bytes: number }[],
    ) =>
      files.length === givenIds.length + local.length &&
      givenIds.every((id, index) => files[index]?.id === id) &&
      local.every((entry, index) => {
        const item = files[givenIds.length + index];
        return (
          item?.filename === entry.filename &&
          item.size_bytes === entry.size_bytes
        );
      });
    const same = (await allProducts(session, context)).find(
      (item) =>
        item.status === "active" &&
        item.name === name &&
        item.price_jpy === priceJpy &&
        (feature
          ? item.access_type === "feature" &&
            sameMetadata(item.metadata ?? {}, metadata)
          : file
            ? item.access_type === "file" &&
              item.files !== undefined &&
              sameFiles(item.files)
            : // URLを持たない商品（feature・file）は限定ページの商品と同じにならない。
              item.access_type !== "feature" &&
              item.access_type !== "file" &&
              item.access_url !== null &&
              accessUrl !== undefined &&
              sameUrl(item.access_url, accessUrl)),
    );
    if (same) {
      const found = await existingLink(session, context, same.id);
      const linkStep = found
        ? null
        : `${CLI} link ${same.id}${profileSuffix(session.profile)}`;
      const keyStep = feature
        ? featureKeyRequest(
            session,
            (await getAccount()).environment === "sandbox",
          )
        : null;
      return {
        data: {
          product: same,
          checkout_link: found,
          reused: true,
          reason: "same_product_exists",
          next_step:
            linkStep && keyStep
              ? `${linkStep} のあと、${keyStep}`
              : (linkStep ?? keyStep),
        },
        human: [
          `同じ内容の商品がすでにあるため、新しく作らずにその商品を返しました: ${same.name}（${yen(same.price_jpy)}）`,
          `商品ID: ${same.id}`,
          found
            ? `購入リンク: ${found.url}${found.disabled ? "（無効）" : ""}`
            : `購入リンク: 未発行（${CLI} link ${same.id} で発行できます）`,
          "別の商品として作るには --allow-duplicate を付けます。",
        ],
      };
    }
  }
  const fileNames = [...givenIds, ...paths];
  await context.confirm(
    feature
      ? `商品「${name}」を ${yen(priceJpy)} で作成します。種類: ${featureLabel(metadata)}。種類は作成後に変えられません。`
      : file
        ? `商品「${name}」を ${yen(priceJpy)} で作成します。種類: ファイル（${fileNames.join("、")}）。購入した人がダウンロードできます。種類は作成後に変えられません。`
        : `商品「${name}」を ${yen(priceJpy)} で作成します。購入後に表示するページ: ${accessUrl}`,
    {
      action: "create",
      product: feature
        ? { name, price_jpy: priceJpy, access_type: "feature", metadata }
        : file
          ? {
              name,
              price_jpy: priceJpy,
              access_type: "file",
              file_ids: givenIds,
              files_to_upload: paths,
            }
          : { name, price_jpy: priceJpy, access_url: accessUrl },
    },
  );
  // 手元のファイルは確認のあとで上げる。上げ終えたファイルは、作成に失敗しても残る。
  let uploadedIds: string[] = [];
  if (paths.length > 0) {
    if (!upload)
      throw new CliError("internal", "想定外のエラーで中断しました。");
    uploadedIds = (await uploadPaths(session, context, paths, upload)).map(
      (entry) => entry.id,
    );
  }
  const fileIds = [...givenIds, ...uploadedIds];
  const product: CreateProduct = feature
    ? { name, price_jpy: priceJpy, access_type: "feature", metadata }
    : file
      ? { name, price_jpy: priceJpy, access_type: "file", file_ids: fileIds }
      : { name, price_jpy: priceJpy, access_url: accessUrl as string };
  try {
    return await createWithKey(session, context, store, input, product, {
      feature,
      metadata,
      accessUrl,
      fileIds,
      environment: (await getAccount()).environment,
      creatorId: (await getAccount()).creator_id,
    });
  } catch (error) {
    // 上げたファイルのIDを返し、作り直しで同じファイルを上げ直さずに済むようにする。
    if (error instanceof CliError && uploadedIds.length > 0)
      throw new CliError(error.code, error.message, {
        hint: `上げたファイルは残っています。${CLI} products create --name "${name}" --price ${priceJpy} ${fileIds.map((id) => `--file-id ${id}`).join(" ")}${profileSuffix(session.profile)} で作り直せます。`,
        details: { ...error.details, uploaded_file_ids: uploadedIds },
      });
    throw error;
  }
}

async function createWithKey(
  session: Session,
  context: CommandContext,
  store: Store,
  input: ProductInput,
  product: CreateProduct,
  meta: {
    feature: boolean;
    metadata: FeatureFlagMetadata;
    accessUrl?: string;
    fileIds: string[];
    environment: string;
    creatorId: string;
  },
): Promise<Output> {
  const { feature, metadata, accessUrl, fileIds, environment, creatorId } =
    meta;
  // タイムアウト後の再実行で商品が二重にならないよう、入力ごとの冪等キーを送信前に保存する。
  // 限定ページのハッシュは従来のまま変えない（導入の途中のキーを使い回せるように）。
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        feature
          ? [
              session.profile.name,
              creatorId,
              product.name,
              product.price_jpy,
              "feature",
              Object.entries(metadata).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            ]
          : accessUrl === undefined
            ? [
                session.profile.name,
                creatorId,
                product.name,
                product.price_jpy,
                "file",
                fileIds,
              ]
            : [
                session.profile.name,
                creatorId,
                product.name,
                product.price_jpy,
                accessUrl,
              ],
      ),
    )
    .digest("hex");
  const pendingName = `idem-${hash}`;
  const saved = await store.loadPending(pendingName);
  // --allow-duplicate は別の商品を作る意図なので、作成済みのキーは使い回さない
  // （未完了のキーは、タイムアウト後の再実行のために使い回す）。
  const usable =
    record(saved) &&
    typeof saved.idempotency_key === "string" &&
    /^[\x21-\x7E]{1,128}$/.test(saved.idempotency_key) &&
    !(input["allow-duplicate"] && typeof saved.completed_at === "string");
  let idempotencyKey: string;
  let createdAt: string;
  let reused = false;
  if (usable) {
    idempotencyKey = saved.idempotency_key as string;
    createdAt =
      typeof saved.created_at === "string"
        ? saved.created_at
        : new Date(context.now()).toISOString();
    reused = typeof saved.completed_at === "string";
  } else {
    idempotencyKey = randomUUID();
    createdAt = new Date(context.now()).toISOString();
    await store.savePending(pendingName, {
      version: 1,
      idempotency_key: idempotencyKey,
      created_at: createdAt,
      expires_at: new Date(context.now() + IDEMPOTENCY_TTL_MS).toISOString(),
    });
  }
  const created = await call(session, context, () =>
    session.client.products.create(product, { idempotencyKey }),
  );
  // 機能フラグでも標準リンクは作る（固定メールの購入試行が紐づくため）。購入ボタンには使わない。
  const result = checkoutLink(
    await call(session, context, () =>
      session.client.checkoutLinks.ensure(created.id),
    ),
  );
  // 成功後も24時間は同じキーを残す。成功を知らずに打ち直されても、サーバーは同じ商品を返す。
  await store.savePending(pendingName, {
    version: 1,
    idempotency_key: idempotencyKey,
    created_at: createdAt,
    completed_at: new Date(context.now()).toISOString(),
    product_id: created.id,
    expires_at: new Date(context.now() + IDEMPOTENCY_TTL_MS).toISOString(),
  });
  return {
    data: {
      product: created,
      checkout_link: result,
      reused,
      ...(reused ? { reason: "idempotent_retry" } : {}),
      next_step: feature
        ? featureKeyRequest(session, environment === "sandbox")
        : null,
    },
    human: [
      reused
        ? `同じ内容の商品を作成済みのため、その商品を返しました: ${created.name}（${yen(created.price_jpy)}）`
        : `商品を作成しました: ${created.name}（${yen(created.price_jpy)}）`,
      `商品ID: ${created.id}`,
      feature
        ? `公開の購入リンク（購入ボタンには使わず、サーバーの createCheckout を使う）: ${result.url}`
        : `購入リンク: ${result.url}`,
      ...(fileIds.length > 0
        ? [
            `ファイル: ${fileIds.join(", ")}（購入した人は購入後の画面と購入者ポータルからダウンロードできます）`,
          ]
        : []),
    ],
  };
}

/** 期限（24時間）を過ぎた冪等キーを消す。読めないファイルは消さずに残す。 */
export async function removeExpiredIdempotencyKeys(
  store: Store,
  now: number,
): Promise<void> {
  for (const name of await store.listPending("idem-")) {
    try {
      const saved = await store.loadPending(name);
      if (
        record(saved) &&
        typeof saved.expires_at === "string" &&
        Date.parse(saved.expires_at) <= now
      )
        await store.removePending(name);
    } catch {
      // 1件の不備で他のコマンドを止めない。
    }
  }
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
      ...(updated.access_url === null
        ? []
        : [`購入後に表示するページ: ${updated.access_url}`]),
    ],
  };
}
