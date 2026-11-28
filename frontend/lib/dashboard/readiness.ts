import type { Role } from "@/lib/auth/landing";
import { actionFor, type Action } from "./attention";
import type { Readiness } from "./types";

// The readiness canvas: the backend's six checks, each with the place to fix it. A destination is
// offered only when this role may open it (a manager is not sent to People & access).

type CheckKey = Readiness["checks"][number]["key"];

const FIX: Readonly<Record<CheckKey, { label: string; href: string }>> = {
  ACTIVE_PRODUCT: { label: "Add a product", href: "/products" },
  STOCK_OR_SERVICE: { label: "Add stock", href: "/inventory" },
  TAX_REGIME_SET: { label: "Set your tax regime", href: "/settings" },
  FIRST_SALE: { label: "Record a sale", href: "/pos" },
  KRA_PIN: { label: "Add your KRA PIN", href: "/settings" },
  STAFF_BEYOND_OWNER: { label: "Invite staff", href: "/people" },
};

export function fixFor(role: Role, key: CheckKey): Action | undefined {
  const fix = FIX[key];
  return actionFor(role, fix.label, fix.href);
}

/**
 * Whether the dashboard should show the readiness canvas: while any REQUIRED check fails, and
 * also once they all pass but nothing has been sold yet (the "you're ready" moment).
 */
export function showReadiness(readiness: Readiness): boolean {
  if (!readiness.readyToTrade) return true;
  return readiness.checks.some((check) => check.key === "FIRST_SALE" && !check.pass);
}
