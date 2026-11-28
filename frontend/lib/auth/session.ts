import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createApiClient } from "@/lib/api/client";
import { unwrap } from "@/lib/api/errors";
import { ACT_AS_COOKIE } from "./cookies";
import { PATHNAME_HEADER, SESSION_COOKIE } from "./names";
import type { Role } from "./landing";
import { safeReturnTo } from "./landing";

// The current session as the BACKEND sees it: GET /v1/auth/me with the access token from the
// HttpOnly cookie, normalized to ONE shape the whole frontend uses. It never carries a token.

export interface Session {
  user: { id: string; fullName: string; email: string; role: Role; isActive: boolean };
  role: Role;
  tenant: {
    id: string;
    subdomain: string;
    /** The business's display name, from /v1/auth/me. */
    name: string;
    status?: string;
    subscriptionTier?: string;
  } | null;
  /**
   * STANDING GOD-MODE (M4.5 W5): the business a SUPER_ADMIN is currently ACTING AS, from the
   * act-as cookie. Null for everyone else. While set, the admin operates the merchant workspace as
   * that business; the data proxy forwards its id so the backend presents every call as that tenant.
   */
  actingAs: { id: string; name: string } | null;
}

/** The acted business from the HttpOnly act-as cookie — only honoured for a SUPER_ADMIN. */
function readActingAs(store: CookieReader, role: Role): Session["actingAs"] {
  if (role !== "SUPER_ADMIN") return null;
  const raw = store.get(ACT_AS_COOKIE)?.value;
  if (raw === undefined || raw === "") return null;
  try {
    const value = JSON.parse(raw) as { id?: unknown; name?: unknown };
    if (typeof value.id === "string" && value.id !== "") return { id: value.id, name: typeof value.name === "string" ? value.name : value.id };
  } catch {
    // A malformed cookie is simply no act-as.
  }
  return null;
}

export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/** null when there is no session cookie or the backend refuses it (401). */
export async function getSession(store?: CookieReader): Promise<Session | null> {
  const jar = store ?? (await cookies());
  const accessToken = jar.get(SESSION_COOKIE)?.value;
  if (!accessToken) return null;

  const api = createApiClient({ headers: { authorization: `Bearer ${accessToken}` } });
  const result = await api.GET("/v1/auth/me");
  if (result.response.status === 401) return null;
  const me = unwrap(result);
  return {
    user: {
      id: me.user.id,
      fullName: me.user.fullName,
      email: me.user.email,
      role: me.user.role,
      isActive: me.user.isActive,
    },
    role: me.role,
    actingAs: readActingAs(jar, me.role),
    tenant: me.tenant
      ? {
          id: me.tenant.id,
          subdomain: me.tenant.subdomain,
          name: me.tenant.name,
          status: me.tenant.status,
          subscriptionTier: me.tenant.subscriptionTier,
        }
      : null,
  };
}

/**
 * The login URL for a request with no usable session. `reason=expired` when a session cookie was
 * present but refused — the proxy lets that through to /login instead of bouncing it back to "/",
 * which is what stops a stale cookie from looping between the two.
 */
export function loginUrl(opts: { returnTo?: string | null; expired?: boolean }): string {
  const params = new URLSearchParams();
  const returnTo = safeReturnTo(opts.returnTo);
  if (returnTo) params.set("returnTo", returnTo);
  if (opts.expired) params.set("reason", "expired");
  const query = params.toString();
  return query ? `/login?${query}` : "/login";
}

/**
 * The session, or a redirect to /login (with a returnTo to the page asked for). Memoized for the
 * request (React cache), so the layout and the page's access guard share ONE call to the backend.
 */
export const requireSession = cache(async (): Promise<Session> => {
  const jar = await cookies();
  const session = await getSession(jar);
  if (session) return session;
  const returnTo = (await headers()).get(PATHNAME_HEADER);
  redirect(loginUrl({ returnTo, expired: jar.get(SESSION_COOKIE) !== undefined }));
});
