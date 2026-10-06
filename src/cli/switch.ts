// サンドボックスから本番への切り替え（V-23）。
// 本番の管理画面のプロンプトで init すると、既定のプロファイルは sandbox になり、
// 本番のクリエイターIDだけが production の期待値として保存される（V-20）。
// 本番にログインして期待するクリエイターと一致したら、既定を production に書き換える。
// サンドボックスの管理画面から始めた導入（flow が sandbox-only）では、本番へ切り替えない（V-19）。
import {
  CLI,
  convert,
  creatorMismatch,
  type Profile,
  resolveProfile,
  session,
} from "./api.js";
import type { CommandContext, Output } from "./commands.js";
import { CliError } from "./errors.js";
import type { Config, Store } from "./store.js";

/** この本番ログインで、既定をサンドボックスから本番へ切り替える対象か。 */
export function switchesToProduction(
  profile: Profile,
  config: Config,
): boolean {
  return (
    profile.name === "production" &&
    config.default_profile === "sandbox" &&
    config.flow === "sandbox-first" &&
    profile.expectedCreatorId !== undefined
  );
}

/** 切り替えの後に AI が行うこと。 */
export const SWITCHED_NEXT_STEP = [
  "既定の接続先を本番に切り替えました。以後の `npx cozeni` は本番につながります。",
  "テストで確定した商品名・価格・限定にする内容のまま、本番で同じ内容の商品を作ります（利用者に聞き直さない。同じ内容の商品が本番にあれば、作らずにそれが返ります）。",
  '`npx cozeni products create --name "<商品名>" --price <円> --access-url "<本番のサイトのアドレス>/<限定ページのパス>" --yes --json` を実行し、コード中の商品IDと購入リンクを本番のものに差し替え、`COZENI_ENVIRONMENT` を外してください。',
  "本番では決済を試さず、購入していない状態で限定ページが Cozeni の入場画面（enter_url）へリダイレクトされるところまでを確かめ、報告します。",
].join("\n");

/** 本番にログイン済みで一致しているとき、黙って切り替えず、利用者に聞かせる案内。 */
export const ASK_TO_SWITCH_NEXT_STEP = [
  "本番にはログイン済みで、期待するアカウントと一致しています。承認の依頼は不要です。",
  "利用者に「本番に切り替えてよいですか」と聞き、返事を待ってください（自分でテストを試す機会を残すため、黙って切り替えません）。",
  `切り替えてよいと返事があったら、\`${CLI} switch --json\` を実行します。`,
].join("\n");

/** ログインの待ち中に導入の設定が変わっていたため、切り替えなかったときの案内。 */
export const SWITCH_ABORTED_NEXT_STEP = [
  "ログインを待っているあいだに、導入の設定（期待するアカウントや導入の流れ）が変わったため、既定の接続先は切り替えませんでした。",
  `別の導入が進んでいないか確かめ、本番に切り替えるなら、\`${CLI} login --profile production --json\` からやり直してください。`,
].join("\n");

/**
 * 既定のプロファイルを production に書き換える。待ち時間のあいだに設定が変わっていてもよいよう、
 * 最新の設定を読み直し、導入の流れと期待するクリエイターがログイン結果と一致するときだけ、
 * default_profile の1項目だけを更新する。切り替えたら true。
 */
export async function setDefaultToProduction(
  store: Store,
  creatorId: string,
): Promise<boolean> {
  const latest = await store.loadConfig();
  if (
    latest.default_profile !== "sandbox" ||
    latest.flow !== "sandbox-first" ||
    latest.profiles.production?.expected_creator_id !== creatorId
  )
    return false;
  await store.saveConfig({ ...latest, default_profile: "production" });
  return true;
}

/**
 * `cozeni switch`：本番のキーの有効性とクリエイターを本番の `GET /account` で確かめ、
 * 期待するクリエイターと一致したら既定を production にする。
 * 未ログイン・失効・別のアカウントなら、既定は変えない。
 */
export async function switchToProduction(
  context: CommandContext & {
    env: Record<string, string | undefined>;
    fetch: typeof globalThis.fetch;
  },
  store: Store,
): Promise<Output> {
  const config = await store.loadConfig();
  const profile = resolveProfile(
    { profile: "production" },
    context.env,
    config,
  );
  if (!profile.expectedCreatorId)
    throw new CliError(
      "invalid_input",
      "本番で使うアカウントが保存されていません。",
      {
        hint: "導入のプロンプトにある init を、--creator <クリエイターID> 付きでやり直してください。",
      },
    );
  const previous = config.default_profile ?? "production";
  if (previous !== "production" && config.flow !== "sandbox-first")
    throw new CliError(
      "invalid_input",
      "この導入では、本番への切り替えを行いません。",
      {
        hint: "サンドボックスの管理画面から始めた導入は、テスト購入までで止まります。本番へは、本番の管理画面の導入プロンプトを使ってください。",
      },
    );
  const current = await session(
    profile,
    store,
    context.env,
    context.fetch,
    context.now(),
  );
  // 保存したキーのローカルの値ではなく、本番のサーバーでキーの有効性とクリエイターを確かめる。
  let actual: string;
  try {
    actual = (await current.client.account.get()).creator_id;
  } catch (error) {
    throw convert(error, {
      apiOrigin: current.apiOrigin,
      appOrigin: current.appOrigin,
      session: current,
      now: context.now(),
    });
  }
  if (actual !== profile.expectedCreatorId)
    throw creatorMismatch(profile, actual, current.source);
  const changed = previous !== "production";
  if (changed && !(await setDefaultToProduction(store, actual)))
    throw new CliError(
      "invalid_state",
      "導入の設定が途中で変わったため、切り替えませんでした。",
      { hint: SWITCH_ABORTED_NEXT_STEP },
    );
  return {
    data: {
      switched: changed,
      default_profile: "production",
      previous_profile: previous,
      creator_id: actual,
      environment: "production",
      next_step: SWITCHED_NEXT_STEP,
    },
    human: [
      changed
        ? "既定の接続先を本番に切り替えました。"
        : "既定の接続先はすでに本番です。",
      SWITCHED_NEXT_STEP,
    ],
  };
}
