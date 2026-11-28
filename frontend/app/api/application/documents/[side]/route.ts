import { type NextRequest, type NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { BffError, handle } from "@/lib/auth/http";
import { applicationToken, backend, relay } from "@/lib/application/relay";

export const runtime = "nodejs";

const ALLOWED = new Set(["image/jpeg", "image/png", "application/pdf"]);
const MAX_BYTES = 5 * 1024 * 1024;

// One side of the owner's ID, forwarded as the raw file. The BFF only screens the obvious (type
// label, size); what the file IS is decided by the backend from its bytes. Nothing is stored here.
export function PUT(request: NextRequest, context: { params: Promise<{ side: string }> }): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const { side } = await context.params;
    if (side !== "FRONT" && side !== "BACK") throw new BffError(404, "NotFound", "Not found.");
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ALLOWED.has(contentType)) throw new BffError(415, "UnsupportedMediaType", "Upload a JPG, PNG or PDF file.");
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BYTES) throw new BffError(413, "PayloadTooLarge", "The file is larger than 5 MB. Upload a smaller photo or scan.");
    return relay(await backend(request, `/applications/current/documents/${side}`, { method: "PUT", token: applicationToken(request), raw: { body, contentType } }));
  });
}
