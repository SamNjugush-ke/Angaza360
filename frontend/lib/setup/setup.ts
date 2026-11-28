import type { Readiness } from "@/lib/dashboard/types";

// THE FIRST-LOGIN GUIDED SETUP (M4.5 Wave 2). A skippable checklist that walks a new business
// through the screens that already exist — it changes nothing itself. A step is DONE when the
// backend's readiness says so (where readiness has a check for it), or when the owner marked it
// done or skipped it here; those two marks are a per-viewer convenience kept in this browser only.
// Opening stock is not offered to a business that sells only services.

type CheckKey = Readiness["checks"][number]["key"];

export type SetupStepKey =
  | "details"
  | "branding"
  | "tax"
  | "catalog"
  | "stock"
  | "locations"
  | "staff"
  | "integrations"
  | "readiness"
  | "first-sale";

export interface SetupStep {
  key: SetupStepKey;
  title: string;
  detail: string;
  href: string;
  action: string;
  /** The readiness check that decides it, when there is one. */
  check?: CheckKey;
}

export const SETUP_STEPS: readonly SetupStep[] = [
  { key: "details", title: "Confirm your business details", detail: "Your legal name, address, phone and KRA PIN — printed on every receipt.", href: "/settings?tab=profile", action: "Open business profile", check: "KRA_PIN" },
  { key: "branding", title: "Brand your receipts", detail: "Your colour, logo and the footer customers see.", href: "/settings?tab=branding", action: "Open branding" },
  { key: "tax", title: "Check your tax settings", detail: "How the business is taxed decides how every sale and purchase posts.", href: "/settings?tab=profile", action: "Check tax regime", check: "TAX_REGIME_SET" },
  { key: "catalog", title: "Add what you sell", detail: "Products and services, one at a time or from a CSV file.", href: "/products", action: "Open products", check: "ACTIVE_PRODUCT" },
  { key: "stock", title: "Record your opening stock", detail: "The goods you already hold, so the books start from the truth.", href: "/inventory", action: "Open inventory", check: "STOCK_OR_SERVICE" },
  { key: "locations", title: "Set up your locations", detail: "Tills, branches or a store room — each holds its own stock.", href: "/inventory", action: "Open locations" },
  { key: "staff", title: "Invite your staff", detail: "Cashiers, a manager or your accountant, each with their own sign-in.", href: "/people", action: "Invite staff", check: "STAFF_BEYOND_OWNER" },
  { key: "integrations", title: "Connect M-Pesa and KRA eTIMS", detail: "Optional — your own Till and eTIMS device. You can do this later.", href: "/settings?tab=integrations", action: "Open integrations" },
  { key: "readiness", title: "Check you are ready to trade", detail: "Your dashboard lists anything still required.", href: "/dashboard", action: "Open the dashboard" },
  { key: "first-sale", title: "Record your first sale", detail: "Ring it up at the till — the dashboard fills in from there.", href: "/pos", action: "Open the till", check: "FIRST_SALE" },
];

export type SetupMarks = Partial<Record<SetupStepKey, "done" | "skipped">>;

const STORAGE_KEY = "ag_setup_marks";

export function readMarks(): SetupMarks {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? (parsed as SetupMarks) : {};
  } catch {
    return {};
  }
}

export function writeMarks(marks: SetupMarks): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
  } catch {
    // Storage blocked (private window): the marks last for this visit only, which is harmless.
  }
}

/**
 * The steps that apply: opening stock is left out for a catalog with products but no goods
 * (a pure-service business has nothing to count). `hasGoods` null means not yet known.
 */
export function applicableSteps(hasProducts: boolean, hasGoods: boolean | null): readonly SetupStep[] {
  return SETUP_STEPS.filter((step) => !(step.key === "stock" && hasProducts && hasGoods === false));
}

export type StepState = "done" | "skipped" | "todo";

export function stateOf(step: SetupStep, readiness: Readiness | null, marks: SetupMarks): StepState {
  const check = step.check ? readiness?.checks.find((c) => c.key === step.check) : undefined;
  if (check?.pass) return "done";
  if (step.key === "readiness" && readiness?.readyToTrade) return "done";
  return marks[step.key] ?? "todo";
}
