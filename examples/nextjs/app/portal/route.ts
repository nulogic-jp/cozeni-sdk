import { portalRedirect } from "@nulogic/cozeni-sdk/next";
import { CREATOR_ID } from "../../lib/cozeni";

export const dynamic = "force-dynamic";

// 「購入した商品」ボタンの遷移先。押されたときにCozeniの購入者ポータルへのリンクを発行して302で送る。
// リンクは60秒・1回限りなので、ページの描画時に発行して<a href>へ埋め込まない。
export function GET() {
  return portalRedirect(CREATOR_ID);
}
