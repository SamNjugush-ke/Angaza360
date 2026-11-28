import type { Role } from "@/lib/auth/landing";
import type { Workspace } from "@/lib/nav/workspace";

/** What the shell is told about the signed-in user — display data only, never a token. */
export interface ShellContext {
  fullName: string;
  email: string;
  role: Role;
  workspace: Workspace;
  /** The business (merchant) or the workspace's own name (mentorship / admin). */
  contextName: string;
  /** Set while a SUPER_ADMIN is acting as a business (god-mode) — drives the operator banner. */
  actingAs?: { name: string } | null;
}
