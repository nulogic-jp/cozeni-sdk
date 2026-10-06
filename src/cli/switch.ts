// サンドボックスから本番への切り替え（V-23）。
// 本番の管理画面のプロンプトで init すると、既定のプロファイルは sandbox になり、
// 本番のクリエイターIDだけが production の期待値として保存される（V-20）。
// 本番にログインして期待するクリエイターと一致したら、既定を production に書き換える。
import {
  CLI,
  type Profile,
  resolveProfile,
  session,
  verifyCreator,
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

/** 既定のプロファイルを production に書き換える。ログインと期待するクリエイターの確認は呼び出し側が済ませる。 */
export async function setDefaultToProduction(
  store: Store,
  config: Config,
): Promise<void> {
  await store.saveConfig({ ...config, default_profile: "production" });
}

/**
 * `cozeni switch`：本番のログインを確かめ、期待するクリエイターと一致したら既定を production にする。
 * 未ログインなら login_required、別のアカウントなら creator_mismatch で止まり、既定は変えない。
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
  const current = await session(
    profile,
    store,
    context.env,
    context.fetch,
    context.now(),
  );
  await verifyCreator(current, context.now());
  const previous = config.default_profile ?? "production";
  const changed = previous !== "production";
  if (changed) await setDefaultToProduction(store, config);
  return {
    data: {
      switched: changed,
      default_profile: "production",
      previous_profile: previous,
      creator_id: profile.expectedCreatorId,
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
