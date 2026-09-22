import {
  AccessDenied,
  denialStatus,
  protectedData,
  reportServerError,
  requireEntitlement,
} from "../../../lib/cozeni";
export const dynamic = "force-dynamic";
export async function GET() {
  const headers = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  };
  try {
    await requireEntitlement();
    return Response.json(await protectedData(), { headers });
  } catch (error) {
    reportServerError(error, "保護データAPI");
    const reason = error instanceof AccessDenied ? error.reason : "unavailable";
    return Response.json(
      { error: reason },
      { status: denialStatus(reason), headers },
    );
  }
}
