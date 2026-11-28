import { type NextRequest, type NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { handle } from "@/lib/auth/http";
import { applicationToken, backend, relay } from "@/lib/application/relay";

export const runtime = "nodejs";

/** Submits (or resubmits) the open application for review. */
export function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    return relay(await backend(request, "/applications/current/submit", { method: "POST", token: applicationToken(request) }));
  });
}
