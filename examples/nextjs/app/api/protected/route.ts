import { denialResponse, entitlement } from "@nulogic/cozeni-sdk/next";
import { PROTECTED_CONTENT } from "../../../lib/content";
import { PRODUCT_ID } from "../../../lib/cozeni";

export const dynamic = "force-dynamic";

// JSONを返す入口はリダイレクトしない。拒否は401/403/503で、enter_urlは本文に含める。
export async function GET() {
  const result = await entitlement(PRODUCT_ID);
  if (!result.entitled) return denialResponse(result, PRODUCT_ID);
  return Response.json(
    { content: PROTECTED_CONTENT },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}
