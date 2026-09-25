"use server";
import { entitlement } from "@nulogic/cozeni-sdk/next";
import { PROTECTED_CONTENT } from "../../lib/content";
import { PRODUCT_ID } from "../../lib/cozeni";

// Server Actionは直接POSTされうるので、ページとは別に毎回認可する。
// リダイレクトせず、拒否の理由をplain objectで返す。
export async function protectedAction(): Promise<
  { ok: true; content: string } | { ok: false; reason: string }
> {
  const result = await entitlement(PRODUCT_ID);
  if (!result.entitled) return { ok: false, reason: result.reason };
  return { ok: true, content: PROTECTED_CONTENT };
}

// フォームからの呼び出しも同じ認可済み操作を使う。
export async function submitProtectedAction() {
  await protectedAction();
}
