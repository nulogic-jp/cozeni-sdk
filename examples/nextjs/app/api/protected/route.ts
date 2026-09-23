import { AccessDenied, denialResponse } from "@nulogic/cozeni-sdk/next";
import {
  productId,
  protectedData,
  reportServerError,
} from "../../../lib/cozeni";
export const dynamic = "force-dynamic";
export async function GET() {
  const headers = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  };
  try {
    return Response.json(await protectedData(), { headers });
  } catch (error) {
    reportServerError(error, "保護データAPI");
    // Route Handlerはリダイレクトせず、enter_urlをJSON本文へ含めて拒否する。
    // denialResponse()はproductId一致をenter_url採用の条件に含めて再検証する。
    return denialResponse(
      error instanceof AccessDenied
        ? error.entitlement
        : { entitled: false, reason: "unavailable" },
      productId(),
    );
  }
}
