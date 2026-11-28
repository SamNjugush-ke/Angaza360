import { logoutRoute } from "@/lib/auth/logout";

export const runtime = "nodejs";

export const POST = logoutRoute("/v1/auth/logout");
