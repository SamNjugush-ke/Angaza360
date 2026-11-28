import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import type { ShellContext } from "@/components/shell/types";
import { requireSession, type Session } from "@/lib/auth/session";
import { resolveWorkspace, WORKSPACE_NAME, type Workspace } from "@/lib/nav/workspace";

// The authenticated area. Every page under it is behind requireSession() and kept out of the
// index (FP-SEO: authenticated routes are noindex). The per-ROLE check is NOT here: a layout does
// not re-render on client-side navigation, so each page carries it instead (lib/auth/guard.tsx).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

function contextName(session: Session, workspace: Workspace): string {
  if (workspace !== "merchant") return WORKSPACE_NAME[workspace];
  return session.tenant?.name ?? session.tenant?.subdomain ?? "Your business";
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  // While an operator acts as a business (god-mode), the shell is that business's MERCHANT workspace
  // and nav — they operate as its owner — with a banner (below) making the operator mode plain.
  const acting = session.actingAs;
  const navRole = acting !== null ? "MSME_OWNER" : session.role;
  const workspace = resolveWorkspace(navRole);
  const context: ShellContext = {
    fullName: session.user.fullName,
    email: session.user.email,
    role: navRole,
    workspace,
    contextName: acting !== null ? acting.name : contextName(session, workspace),
    actingAs: acting !== null ? { name: acting.name } : null,
  };
  return <AppShell context={context}>{children}</AppShell>;
}
