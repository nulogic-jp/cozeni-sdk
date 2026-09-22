"use server";
import {
  AccessDenied,
  protectedData,
  reportServerError,
  requireEntitlement,
} from "../../lib/cozeni";
export async function protectedAction(): Promise<
  { ok: true; content: string } | { ok: false; reason: string }
> {
  try {
    // Server Actionを直接POSTされた場合も、操作前に必ず認可する。
    await requireEntitlement();
    const data = await protectedData();
    return { ok: true, content: data.content };
  } catch (error) {
    reportServerError(error, "購入者操作");
    if (error instanceof AccessDenied)
      return { ok: false, reason: error.reason };
    return { ok: false, reason: "unavailable" };
  }
}
// フォームからの呼び出しも同じ認可済み操作を利用する。
export async function submitProtectedAction() {
  await protectedAction();
}
