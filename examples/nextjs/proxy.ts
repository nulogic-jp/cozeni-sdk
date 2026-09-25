// Cozeniから戻ったときの cozeni_code の交換と、無限リダイレクトを止める印の管理をSDKに任せる。
// Next.js 15以前は middleware.ts に `export { cozeniProxy as middleware } ...` と書く。
export { cozeniProxy as proxy } from "@nulogic/cozeni-sdk/next";

export const config = {
  // 静的ファイルでは動かさない。保護ページ（商品の access_url）は必ず対象に含める。
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
