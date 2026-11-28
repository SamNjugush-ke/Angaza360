import type { Role } from "@/lib/auth/landing";

// Which chrome a role works in. One shell, three nav sets.
export type Workspace = "merchant" | "mentorship" | "admin";

const WORKSPACE_OF: Readonly<Record<Role, Workspace>> = {
  MSME_OWNER: "merchant",
  MSME_MANAGER: "merchant",
  ACCOUNTANT: "merchant",
  CASHIER: "merchant",
  HR_OFFICER: "merchant",
  WAREHOUSE_STAFF: "merchant",
  VIEWER_AUDITOR: "merchant",
  MENTOR: "mentorship",
  COACH: "mentorship",
  SUPER_ADMIN: "admin",
  PROGRAM_OFFICER: "admin",
};

export function resolveWorkspace(role: Role): Workspace {
  return WORKSPACE_OF[role];
}

/** The display name of a non-merchant workspace (a merchant shows its business name instead). */
export const WORKSPACE_NAME: Readonly<Record<Exclude<Workspace, "merchant">, string>> = {
  mentorship: "Mentorship",
  admin: "Platform administration",
};
