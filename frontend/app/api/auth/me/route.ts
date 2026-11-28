import { NextResponse, type NextRequest } from "next/server";
import { ApiRequestError } from "@/lib/api/errors";
import { BffError, errorResponse, handle } from "@/lib/auth/http";
import { getSession } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    let session;
    try {
      session = await getSession(request.cookies);
    } catch (err) {
      if (err instanceof ApiRequestError || err instanceof TypeError) {
        throw new BffError(502, "BadGateway", "The sign-in service is unavailable.");
      }
      throw err;
    }
    if (!session) return errorResponse(401, "Unauthorized", "Not signed in.");
    return NextResponse.json(session, { status: 200 });
  });
}
