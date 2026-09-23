import { AccessDenied, denialResponse } from "@nulogic/cozeni-sdk/next";
import { protectedData, reportServerError } from "../../../lib/cozeni";
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
    return denialResponse(
      error instanceof AccessDenied
        ? error.entitlement
        : { entitled: false, reason: "unavailable" },
    );
  }
}
