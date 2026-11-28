import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ROLE_LANDING } from "@/lib/auth/landing";
import { SESSION_COOKIE } from "@/lib/auth/names";
import { getSession, loginUrl } from "@/lib/auth/session";

// /workspace has no page of its own: it sends a signed-in user to their role's workspace and
// everyone else to sign in. proxy.ts routes a signed-in visitor's "/" here, so the landing page
// itself can stay static (the role is only known once the backend has confirmed the session).
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function Workspace(): Promise<never> {
  const jar = await cookies();
  const session = await getSession(jar);
  if (!session) redirect(loginUrl({ expired: jar.get(SESSION_COOKIE) !== undefined }));
  redirect(ROLE_LANDING[session.role]);
}
