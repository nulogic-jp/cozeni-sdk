// `cozeni test-purchase`：サンドボックス専用。サーバーがテストカードで決済を確定させ、
// CLI が受け取ったワンタイムコードで開発サーバーの限定ページに入れることを確かめ、返金する（V-22・V-26）。
// ワンタイムコードと購入者の Cookie は、どの出力・エラーにも含めない。
import {
  CozeniError,
  failure,
  isLoopback,
  record,
  type Send,
} from "../transport.js";
import {
  checkoutOrigin,
  convert,
  PRODUCTION_API_ORIGIN,
  type Profile,
  type Session,
} from "./api.js";
import { type CommandContext, call, type Output } from "./commands.js";
import { CliError } from "./errors.js";
import { CLI } from "./invocation.js";
import { COMPLETE_WAIT_MS, DEFAULT_POLL_INTERVAL_MS } from "./login.js";
import type { Flow } from "./store.js";

const PRODUCT_ID = /^prd_[A-Za-z0-9_-]{1,120}$/;
/** 決済の確定は Stripe を呼ぶため、通常の管理 API より長く待つ。 */
const REQUEST_TIMEOUT_MS = 30_000;
/** 開発サーバーへの1要求の待ち時間。 */
const SITE_TIMEOUT_MS = 15_000;
const TEST_CARD = "4242 4242 4242 4242";

export interface TestPurchaseFlags {
  product?: string;
  "site-origin"?: string;
}
export interface TestPurchaseContext extends CommandContext {
  fetch: typeof globalThis.fetch;
  sleep(ms: number): Promise<void>;
}

const invalidSiteOrigin = () =>
  new CliError(
    "invalid_input",
    "--site-origin はオリジン（例: http://localhost:3000）で指定してください。",
  );

/** 通信の前に、送ってはいけない組み合わせを止める。 */
export function assertTestPurchaseAllowed(
  profile: Profile,
  flags: TestPurchaseFlags,
): { productId: string; site: URL } {
  const productId = flags.product;
  if (!productId || !PRODUCT_ID.test(productId))
    throw new CliError(
      "invalid_input",
      "--product には商品ID（prd_ で始まる）を指定してください。",
      { hint: `${CLI} products list で商品IDを確認してください。` },
    );
  if (!flags["site-origin"])
    throw new CliError(
      "invalid_input",
      "--site-origin には、開発サーバーのアドレス（例: http://localhost:3000）を指定してください。",
    );
  if (profile.name === "production")
    throw new CliError(
      "test_purchase_unavailable",
      "本番ではテスト購入を行いません。",
      {
        hint: `テスト購入はサンドボックスだけで行います。既定の接続先が本番のときは、--profile sandbox を付けてください（本番に直接つないでいて、サンドボックスを使わないときは、テスト購入をしていないことを報告に書いてください）。`,
      },
    );
  let site: URL;
  try {
    site = new URL(flags["site-origin"]);
  } catch {
    throw invalidSiteOrigin();
  }
  if (site.protocol !== "http:" && site.protocol !== "https:")
    throw invalidSiteOrigin();
  if (!isLoopback(site))
    throw new CliError(
      "site_origin_not_allowed",
      "--site-origin は手元の開発サーバー（localhost・127.0.0.1・[::1]）に限ります。",
      {
        hint: "購入者のコードを手元の外へ送らないためです。公開中のサイトには使えません。開発サーバーを起動して、そのアドレスを指定してください。",
      },
    );
  if (
    site.username ||
    site.password ||
    site.pathname !== "/" ||
    site.search ||
    site.hash
  )
    throw invalidSiteOrigin();
  return { productId, site };
}

const SANDBOX_STRIPE_ACTION =
  "決済サービスの画面で「テストデータを使う」を押し、SMS のコードに 000-000 を入力する";

function notReady(data: unknown): CliError {
  const error = record(data) && record(data.error) ? data.error : {};
  const blockers = (Array.isArray(error.blockers) ? error.blockers : [])
    .filter(record)
    .map((blocker) => ({
      code: String(blocker.code),
      action_url: String(blocker.action_url),
    }));
  const stripe = blockers.filter((blocker) =>
    blocker.code.startsWith("stripe_"),
  );
  const lines = [
    "売上の受け取り先のテスト登録が済んでいないため、テスト購入できません。",
  ];
  if (stripe.length > 0) {
    lines.push(
      `利用者に、売上の受け取り先のテスト登録を頼んでください（${SANDBOX_STRIPE_ACTION}）。案内するURL: ${stripe
        .map((blocker) => blocker.action_url)
        .join(" ")}`,
      `利用者が登録を終えるのを待ち、\`${CLI} status --json\` で販売できる状態（sales.can_sell）になったことを確かめてから、同じコマンドを打ち直してください。`,
    );
  } else
    lines.push(
      `しばらく待ってから \`${CLI} status --json\` で状態を確かめ、同じコマンドを打ち直してください。`,
    );
  return new CliError(
    "creator_not_ready",
    "販売できる状態ではないため、テスト購入できません。",
    { hint: lines.join("\n"), details: { blockers } },
  );
}

/** テスト購入 API の失敗応答を CLI のエラーへ変換する。 */
function apiFailure(
  response: Response,
  data: unknown,
  session: Session,
  context: CommandContext,
): CliError {
  const code =
    record(data) && record(data.error) && typeof data.error.code === "string"
      ? data.error.code
      : undefined;
  if (response.status === 404 && code === "not_found")
    return new CliError(
      "not_found",
      "この接続先ではテスト購入を使えません（サンドボックス専用です）。",
      {
        hint: `${CLI} login --profile sandbox で、サンドボックスにログインしてください。`,
      },
    );
  if (response.status === 409 && code === "creator_not_ready")
    return notReady(data);
  if (response.status === 502 && code === "stripe_error")
    return new CliError("stripe_error", "テスト決済の処理に失敗しました。", {
      hint: "同じコマンドを打ち直してください。",
    });
  return convert(failure(response, data), {
    apiOrigin: session.apiOrigin,
    appOrigin: session.appOrigin,
    session,
    now: context.now(),
  });
}

async function post(
  send: Send,
  path: string,
  session: Session,
  context: CommandContext,
): Promise<{ response: Response; data: unknown }> {
  try {
    return await send(path, "POST");
  } catch (error) {
    throw convert(error, {
      apiOrigin: session.apiOrigin,
      appOrigin: session.appOrigin,
      session,
      now: context.now(),
    });
  }
}

/** 開発サーバーに送る Cookie。購入者の秘密なので、値はどこにも出さない。 */
class CookieJar {
  private readonly cookies = new Map<string, string>();
  header(): string | undefined {
    return this.cookies.size === 0
      ? undefined
      : [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
  delete(name: string): void {
    this.cookies.delete(name);
  }
  store(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const index = pair.indexOf("=");
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const expired = attributes.some((attribute) => {
        const [key = "", value = ""] = attribute.split("=");
        return key.trim().toLowerCase() === "max-age" && Number(value) <= 0;
      });
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(index + 1).trim());
    }
  }
}

type Fetch = typeof globalThis.fetch;

/** 限定ページのパス。`//host/path` のような値でも、--site-origin のオリジンから出ない。 */
interface PagePath {
  pathname: string;
  search: string;
}
function pageUrl(site: URL, page: PagePath): URL {
  const url = new URL(site.origin);
  url.pathname = page.pathname;
  url.search = page.search;
  return url;
}

async function getPage(
  fetch: Fetch,
  site: URL,
  url: URL,
  jar: CookieJar,
): Promise<Response> {
  // 送信の直前に、宛先が --site-origin と同じオリジンかを確かめる（コードと Cookie を外へ出さない）。
  if (url.origin !== site.origin)
    throw new CliError(
      "site_origin_not_allowed",
      "送信先が --site-origin と一致しないため、送りませんでした。",
      { hint: "商品の限定ページのURLと、--site-origin を確かめてください。" },
    );
  const headers = new Headers();
  const cookie = jar.header();
  if (cookie) headers.set("Cookie", cookie);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
    });
    jar.store(response);
    return response;
  } catch {
    // 例外はURL（ワンタイムコードを含む）を保持しうるため、内容を出さない。
    throw new CliError(
      "site_unreachable",
      `開発サーバー（${site.origin}）に接続できません。`,
      {
        hint: "開発サーバーを起動したまま、同じコマンドを打ち直してください。--site-origin のポートも確かめてください。",
      },
    );
  }
}

const isRedirect = (response: Response) =>
  response.status >= 300 && response.status < 400;

function resolveLocation(response: Response, from: URL): URL | undefined {
  const location = response.headers.get("Location");
  if (!location) return undefined;
  try {
    return new URL(location, from);
  } catch {
    return undefined;
  }
}

interface EntryResult {
  entered: boolean;
  reason?: string;
  hint?: string;
}

/**
 * ハンドオフ（11 §8.3）を辿って、限定ページに入れることを確かめる。
 * コードを除いた同じURLへ 303 で戻り、購入者の Cookie が付き、その Cookie で限定ページが 200 で返ることを求める。
 * ログイン画面や公開ページへの転送は成功にしない。
 */
async function checkEntry(
  fetch: Fetch,
  site: URL,
  page: PagePath,
  code: string,
): Promise<EntryResult> {
  const jar = new CookieJar();
  const first = pageUrl(site, page);
  first.searchParams.set("cozeni_code", code);
  const response = await getPage(fetch, site, first, jar);
  if (!isRedirect(response))
    return {
      entered: false,
      reason: "handoff_not_handled",
      hint: "サイトが `?cozeni_code=` を処理していません。proxy.ts（または middleware）で cozeniProxy / handleCozeniHandoff を使っているか、matcher が限定ページを含むか確かめてください。",
    };
  const mark = jar.get("cozeni_handoff");
  if (mark === "invalid_code" || mark === "unavailable")
    return {
      entered: false,
      reason: mark === "invalid_code" ? "invalid_code" : "handoff_unavailable",
      hint:
        mark === "invalid_code"
          ? "サイトがコードを交換できませんでした。サイトの環境変数に COZENI_ENVIRONMENT=sandbox が設定され、開発サーバーを再起動したか確かめてください。"
          : "サイトから Cozeni に接続できませんでした。開発サーバーのネットワークと、COZENI_API_ORIGIN・COZENI_ENVIRONMENT の設定を確かめてください。",
    };
  // 印は無限リダイレクトの停止用で、確認には要らない。付けたままだと、権利が無くても
  // requireEntitlement がリダイレクトせず200の拒否表示を返し、入れたかどうかを区別できない。
  jar.delete("cozeni_handoff");
  // 実際に送ったURLの複製から cozeni_code だけを消したものが、戻り先の期待値（再要求にも使う）。
  const expected = new URL(first);
  expected.searchParams.delete("cozeni_code");
  const target = resolveLocation(response, first);
  // Cookie はホスト単位で付く。別のホスト（127.0.0.1 と localhost など）へ移ったら、Cookie を送らずに止める。
  if (target && isLoopback(target) && target.hostname !== site.hostname)
    return {
      entered: false,
      reason: "host_mismatch",
      hint: `サイトが別のホスト（${target.hostname}）へ戻しました。購入者の Cookie はホスト単位のため、確認できません。COZENI_SITE_ORIGIN と --site-origin のホストを揃えてください（Next.js 15 では localhost に揃えます）。`,
    };
  if (
    response.status !== 303 ||
    !target ||
    target.origin !== site.origin ||
    // 表記（%20 と +）の違いで食い違わないよう、クエリは解釈した値で比べる。
    target.pathname !== expected.pathname ||
    target.searchParams.toString() !== expected.searchParams.toString()
  )
    return {
      entered: false,
      reason: "unexpected_redirect",
      hint: "コードを除いた同じURLへ 303 で戻る想定でしたが、そうなりませんでした。ログイン画面など別のページへ送られていないか、COZENI_SITE_ORIGIN が開発サーバーのアドレスと一致しているかを確かめてください。",
    };
  if (!jar.get("cozeni_customer"))
    return {
      entered: false,
      reason: "no_customer_cookie",
      hint: "コードを交換しても、購入者の Cookie（cozeni_customer）が付きませんでした。proxy の実装と matcher を確かめてください。",
    };
  const shown = await getPage(fetch, site, expected, jar);
  if (shown.status === 200) return { entered: true };
  if (isRedirect(shown))
    return {
      entered: false,
      reason: "redirected_away",
      hint: "コードを交換したあとも、限定ページから別の場所へ送られました（入場の画面など）。購入権の反映を待って打ち直すか、限定ページの実装を確かめてください。",
    };
  return {
    entered: false,
    reason: `status_${shown.status}`,
    hint: "コードを交換したあとも限定ページが表示されませんでした。購入権の反映を待って打ち直すか、限定ページの実装を確かめてください。",
  };
}

interface UnpurchasedResult {
  redirected: boolean;
  reason?: string;
  hint?: string;
}

/** Cookie なしで同じページを要求し、`enter_url` へ送られることを確かめる。 */
async function checkUnpurchased(
  fetch: Fetch,
  site: URL,
  page: PagePath,
  productId: string,
  enterOrigin: string | undefined,
): Promise<UnpurchasedResult> {
  const url = pageUrl(site, page);
  url.searchParams.delete("cozeni_code");
  const response = await getPage(fetch, site, url, new CookieJar());
  const location = isRedirect(response)
    ? response.headers.get("Location")
    : undefined;
  let target: URL | undefined;
  try {
    target = location ? new URL(location, url) : undefined;
  } catch {
    target = undefined;
  }
  if (!target)
    return {
      redirected: false,
      reason: "not_redirected",
      hint: "未購入（Cookie なし）で限定ページが返りました。限定ページで requireEntitlement を呼んでいるか確かめてください。",
    };
  if (
    target.pathname !== "/enter" ||
    target.searchParams.get("product_id") !== productId
  )
    return {
      redirected: false,
      reason: "unexpected_destination",
      hint: "未購入のとき、Cozeni の入場画面（enter_url）以外へ送られました。限定ページの実装を確かめてください。",
    };
  // enter_url は購入者面のオリジンで組み立てられる（管理画面のオリジンではない）。
  if (enterOrigin && target.origin !== enterOrigin)
    return {
      redirected: false,
      reason: "enter_url_other_environment",
      hint: `未購入のとき ${target.origin}${target.pathname} へ送られましたが、この接続先の入場画面は ${enterOrigin}${target.pathname} です。サイトの proxy の設定（どの環境の Cozeni に問い合わせているか）と、購入リンクがこの接続先のもの（${enterOrigin}/checkout/…）かを確かめてください。`,
    };
  return { redirected: true };
}

const nextStep = (site: URL, flow: Flow | undefined) => {
  const tried = [
    "1. テスト購入が通ったこと。購入していない状態では限定ページに入れず Cozeni の入場画面へ送られ、テスト購入では限定ページに入れました。確認のあと返金したので、ご自身でも試せます。",
    `2. 「ご自身でも購入から入場まで試せます」。開発サーバー（${site.origin}）の購入ボタンから購入します。テストカードは ${TEST_CARD}（有効期限は未来の日付、CVC は任意の3桁）。メールアドレスはログイン用のメールアドレスで購入し、メールに届くコードを入力すると限定ページに入れます。開発サーバーはこの案内のあいだ動かしたままにします。`,
  ];
  // サンドボックスの管理画面から始めた導入は、ここで止める（V-19）。本番への切り替えは案内しない。
  if (flow !== "sandbox-first")
    return [
      "利用者に1通で次を伝えます。",
      ...tried,
      "テスト購入までで導入は終わりです。本番へは進まず、本番の承認も頼みません。本番で販売するときは、本番の管理画面の導入プロンプトを使うよう案内します。",
      "決済画面は操作しません。以後の呼び方は「テスト」です。",
    ].join("\n");
  // 本番へ進む前に利用者の許可を取る。許可を聞く前に本番のログインを始めない（V-23）。
  return [
    "利用者に1通で次を伝えます。",
    ...tried,
    "3. 「サンドボックスで確認できたので、本番を導入してよいですか？」と尋ねます（ご自身で試すなら、試し終わってから返事をもらいます）。",
    `返事を待ちます。本番への導入を許可されたら、\`${CLI} login --profile production --json\` を実行して本番の承認URLとコードを受け取り、利用者に渡して許可してもらいます（本番にログイン済みで期待するアカウントと一致していれば承認URLは出ません。そのときは \`${CLI} switch --json\` で切り替えます）。`,
    `承認の返事を待ち、\`${CLI} login --complete --profile production --json\` を実行します。成功すると既定の接続先が本番に切り替わり、次の手順が返ります。`,
    "許可されなかったら本番へは進まず、テスト用の環境のまま終えます。",
    "決済画面は操作しません。以後の呼び方は「テスト」です。",
  ].join("\n");
};

/** プロファイル名ではなく、実際に送る先の API が本番なら送らない（別名のプロファイルを含む）。 */
export function assertNotProductionApi(current: Session): void {
  if (current.apiOrigin === PRODUCTION_API_ORIGIN)
    throw new CliError(
      "test_purchase_unavailable",
      "接続先が本番の API のため、テスト購入を行いません。",
      {
        hint: "テスト購入はサンドボックスだけで行います。--profile sandbox を付けてください。",
      },
    );
}

export async function testPurchase(
  current: Session,
  context: TestPurchaseContext,
  target: { productId: string; site: URL; flow?: Flow },
): Promise<Output> {
  const { productId, site } = target;
  const product = await call(current, context, () =>
    current.client.products.get(productId),
  );
  let page: PagePath;
  try {
    const access = new URL(product.access_url);
    page = { pathname: access.pathname, search: access.search };
  } catch {
    throw new CliError(
      "invalid_response",
      "商品の限定ページのURLが想定外です。",
    );
  }
  const base = `/products/${encodeURIComponent(productId)}/test-purchase`;

  // 開始。202 のあいだ、login --complete と同じ間隔・最長90秒で打ち直す。
  const deadline = context.now() + COMPLETE_WAIT_MS;
  const pending = () =>
    new CliError("authorization_pending", "テスト購入の確定を待っています。", {
      hint: "購入権ができるまで時間がかかっています。同じコマンドを打ち直してください（処理中の決済があれば、新たに決済しません）。",
    });
  // 期限までの残り時間を超えて待たない。要求の前に期限を確かめ、タイムアウトを残り時間に抑える。
  const startRequest = async () => {
    const remaining = deadline - context.now();
    if (remaining < 1000) throw pending();
    const clipped = remaining <= REQUEST_TIMEOUT_MS;
    return await current
      .send(Math.min(REQUEST_TIMEOUT_MS, remaining))(base, "POST")
      .catch((error: unknown) => {
        // 期限で打ち切ったタイムアウトだけ待ちとして返す（終了コード6）。即時の通信失敗は5のまま。
        if (clipped && error instanceof CozeniError && error.code === "timeout")
          throw pending();
        throw convert(error, {
          apiOrigin: current.apiOrigin,
          appOrigin: current.appOrigin,
          session: current,
          now: context.now(),
        });
      });
  };
  const send = current.send(REQUEST_TIMEOUT_MS);
  let code: string | null = null;
  for (;;) {
    const { response, data } = await startRequest();
    if (response.status === 202 && record(data) && data.status === "pending") {
      if (context.now() + DEFAULT_POLL_INTERVAL_MS > deadline) throw pending();
      await context.sleep(DEFAULT_POLL_INTERVAL_MS);
      continue;
    }
    if (
      response.status === 200 &&
      record(data) &&
      data.status === "completed"
    ) {
      if (data.handoff_code !== null && typeof data.handoff_code !== "string")
        throw new CliError(
          "invalid_response",
          "テスト購入の応答が想定外です。",
        );
      code = data.handoff_code;
      break;
    }
    if (response.ok)
      throw new CliError("invalid_response", "テスト購入の応答が想定外です。");
    throw apiFailure(response, data, current, context);
  }
  if (code === null)
    throw new CliError(
      "invalid_response",
      "入場の確認に使うコードが返りませんでした（限定ページの無い商品です）。",
      {
        hint: `${CLI} products get ${productId} で、商品の限定ページを確かめてください。`,
      },
    );

  // 入場の確認。コードは手元の開発サーバーにだけ送り、出力しない。
  const entry = await checkEntry(context.fetch, site, page, code);
  const unpurchased = await checkUnpurchased(
    context.fetch,
    site,
    page,
    productId,
    checkoutOrigin(current.profile),
  );
  if (!entry.entered || !unpurchased.redirected) {
    const failed = !entry.entered ? entry : unpurchased;
    throw new CliError(
      "entry_check_failed",
      !entry.entered
        ? "テスト購入のあと、限定ページに入れませんでした。"
        : "未購入のとき、入場画面（enter_url）へ送られませんでした。",
      {
        hint: `${failed.hint ?? ""}\n直したら同じコマンドを打ち直してください（購入権は残っているので、決済せずに確認から行い、確認が済んだら返金します）。返金の直後は、反映まで少し待ってから打ち直してください。`.trim(),
        details: {
          entered: entry.entered,
          redirected_when_unpurchased: unpurchased.redirected,
          refunded: false,
          reason: failed.reason,
        },
      },
    );
  }

  // 確認が済んだら返金する。返金済み・対象なしでも成功として扱う（打ち直しで失敗しない）。
  const refund = await post(send, `${base}/refund`, current, context);
  if (
    refund.response.status !== 200 ||
    !record(refund.data) ||
    (refund.data.status !== "refunded" &&
      refund.data.status !== "nothing_to_refund")
  ) {
    const error = refund.response.ok
      ? new CliError("invalid_response", "返金の応答が想定外です。")
      : apiFailure(refund.response, refund.data, current, context);
    throw new CliError(error.code, error.message, {
      hint: `${error.hint ? `${error.hint}\n` : ""}入場の確認は済んでいます。同じコマンドを打ち直すと、既存の購入権を確かめてから返金します。`,
      details: {
        ...error.details,
        entered: true,
        redirected_when_unpurchased: true,
        refunded: false,
      },
    });
  }
  const refundCount =
    typeof refund.data.refund_count === "number" ? refund.data.refund_count : 0;
  const refunded = refund.data.status === "refunded";
  const steps = nextStep(site, target.flow);
  return {
    data: {
      profile: current.profile.name,
      product_id: productId,
      site_origin: site.origin,
      entered: true,
      redirected_when_unpurchased: true,
      refunded,
      refund_count: refundCount,
      next_step: steps,
    },
    human: [
      "テスト購入が通りました。",
      "- 購入後は限定ページに入れました。",
      "- 未購入では、入場画面（enter_url）へ送られました。",
      refunded
        ? "- テスト購入は返金しました。"
        : "- 返金の対象はありませんでした。",
      steps,
    ],
  };
}
