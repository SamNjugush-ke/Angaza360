import { type NextRequest, type NextResponse } from "next/server";
import { assertSameOriginRead } from "@/lib/auth/csrf";
import { handle } from "@/lib/auth/http";
import { backend, relay } from "@/lib/application/relay";

export const runtime = "nodejs";

/** What the form offers: counties, structures, tax regimes, tiers and the file-size limit. */
export function GET(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOriginRead(request);
    return relay(await backend(request, "/onboarding-options", { method: "GET" }));
  });
}
