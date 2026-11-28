import type { Role } from "@/lib/auth/landing";

/** How a role is named in the interface. */
export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  MSME_OWNER: "Owner",
  MSME_MANAGER: "Manager",
  ACCOUNTANT: "Accountant",
  CASHIER: "Cashier",
  WAREHOUSE_STAFF: "Warehouse staff",
  HR_OFFICER: "HR officer",
  VIEWER_AUDITOR: "Viewer / auditor",
  MENTOR: "Mentor",
  COACH: "Coach",
  SUPER_ADMIN: "Super admin",
  PROGRAM_OFFICER: "Programme officer",
};

/** Up to two initials for an avatar. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[words.length - 1][0]}`;
  return letters.toUpperCase();
}
