import {
  Activity,
  BarChart3,
  Boxes,
  Building2,
  CalendarDays,
  ClipboardList,
  FileCheck2,
  FileDown,
  Gauge,
  HandCoins,
  HeartHandshake,
  Landmark,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  Package,
  PlugZap,
  Receipt,
  ScrollText,
  Settings,
  ShoppingCart,
  Store,
  Timer,
  Truck,
  UserCog,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react";
import type { Role } from "@/lib/auth/landing";
import { resolveWorkspace, type Workspace } from "./workspace";

// The navigation, as data. An item renders only for the roles listed against it, and each list
// MIRRORS THE BACKEND: a role appears only where at least one of the backend routes behind that
// page admits it (any-access). The backend still decides every read and write — this config only
// avoids showing a door that would answer 403. It invents no permission of its own.

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  roles: readonly Role[];
}

export interface NavGroup {
  id: string;
  /** Shown as a group heading; null for an ungrouped set. */
  label: string | null;
  /** "foot" groups sit at the bottom of the sidebar. */
  placement: "main" | "foot";
  items: readonly NavItem[];
}

const OWNER = "MSME_OWNER";
const MANAGER = "MSME_MANAGER";
const ACCOUNTANT = "ACCOUNTANT";
const CASHIER = "CASHIER";
const WAREHOUSE = "WAREHOUSE_STAFF";
const HR = "HR_OFFICER";
const VIEWER = "VIEWER_AUDITOR";

const MERCHANT: readonly NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    placement: "main",
    items: [{ path: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: [OWNER, MANAGER, ACCOUNTANT, VIEWER] }],
  },
  {
    id: "sell",
    label: "Sell",
    placement: "main",
    items: [
      { path: "/pos", label: "Point of Sale", icon: ShoppingCart, roles: [OWNER, MANAGER, CASHIER] },
      { path: "/sales", label: "Sales & receipts", icon: Receipt, roles: [OWNER, MANAGER, CASHIER, ACCOUNTANT, VIEWER] },
    ],
  },
  {
    id: "catalog",
    label: "Catalog & stock",
    placement: "main",
    items: [
      // ACCOUNTANT is deliberately absent: every /v1/products route refuses it (decided for F0.2-E).
      { path: "/products", label: "Products & services", icon: Package, roles: [OWNER, MANAGER, CASHIER, WAREHOUSE, VIEWER] },
      { path: "/inventory", label: "Inventory & locations", icon: Boxes, roles: [OWNER, MANAGER, WAREHOUSE, ACCOUNTANT, VIEWER] },
      { path: "/procurement", label: "Procurement", icon: Truck, roles: [OWNER, MANAGER, ACCOUNTANT, WAREHOUSE, VIEWER] },
    ],
  },
  {
    id: "money",
    label: "Money",
    placement: "main",
    items: [
      { path: "/customers", label: "Customers & receivables", icon: HandCoins, roles: [OWNER, MANAGER, ACCOUNTANT, CASHIER, VIEWER] },
      { path: "/expenses", label: "Expenses & payables", icon: Wallet, roles: [OWNER, MANAGER, ACCOUNTANT, VIEWER] },
      { path: "/accounting", label: "Accounting & reports", icon: BarChart3, roles: [OWNER, MANAGER, ACCOUNTANT, VIEWER] },
      { path: "/payroll", label: "Payroll", icon: Landmark, roles: [OWNER, MANAGER, HR, ACCOUNTANT, VIEWER] },
    ],
  },
  {
    id: "compliance",
    label: "Compliance",
    placement: "main",
    items: [{ path: "/tax", label: "KRA eTIMS & tax", icon: FileCheck2, roles: [OWNER, MANAGER, ACCOUNTANT, VIEWER] }],
  },
  {
    id: "foot",
    label: null,
    placement: "foot",
    items: [
      // T-B4 (M4.5 W4): every merchant role has at least one report of its own (the library lists
      // them). In the foot group so no role's bottom-bar destinations move.
      { path: "/exports", label: "Reports & exports", icon: FileDown, roles: [OWNER, MANAGER, ACCOUNTANT, VIEWER, CASHIER, WAREHOUSE, HR] },
      { path: "/people", label: "People & access", icon: UserCog, roles: [OWNER] },
      { path: "/settings", label: "Business setup", icon: Settings, roles: [OWNER, MANAGER] },
      { path: "/mentorship", label: "Mentorship", icon: HeartHandshake, roles: [OWNER] },
    ],
  },
];

const MENTORING: readonly Role[] = ["MENTOR", "COACH"];
const MENTORSHIP: readonly NavGroup[] = [
  {
    id: "mentorship",
    label: null,
    placement: "main",
    items: [
      { path: "/mentorship", label: "My engagements", icon: HeartHandshake, roles: MENTORING },
      { path: "/mentorship/mentees", label: "Mentees", icon: UsersRound, roles: MENTORING },
      { path: "/mentorship/action-items", label: "Action items", icon: ListChecks, roles: MENTORING },
      { path: "/mentorship/sessions", label: "Sessions", icon: CalendarDays, roles: MENTORING },
      { path: "/mentorship/cohort", label: "Cohort", icon: Activity, roles: MENTORING },
    ],
  },
];

const PLATFORM: readonly Role[] = ["SUPER_ADMIN", "PROGRAM_OFFICER"];
// THE COMMAND CENTER (M4.5 W5): the platform console, grouped as an operations console reads —
// the overview first, then businesses, programmes, operations and governance. Every item mirrors
// the API behind it: support access, integrations, jobs and reports are platform staff's (writes
// inside them are the SUPER_ADMIN's, gated on the page and by the API); Users is SUPER_ADMIN only.
const ADMIN: readonly NavGroup[] = [
  {
    id: "admin",
    label: null,
    placement: "main",
    items: [{ path: "/admin", label: "Overview", icon: Gauge, roles: PLATFORM }],
  },
  {
    id: "admin-businesses",
    label: "Businesses",
    placement: "main",
    items: [
      { path: "/admin/applications", label: "Applications", icon: ClipboardList, roles: PLATFORM },
      { path: "/admin/tenants", label: "Tenants", icon: Building2, roles: PLATFORM },
    ],
  },
  {
    id: "admin-programmes",
    label: "Programmes",
    placement: "main",
    items: [{ path: "/admin/donor-projects", label: "Donor projects", icon: Store, roles: PLATFORM }],
  },
  {
    id: "admin-operations",
    label: "Operations",
    placement: "main",
    items: [
      { path: "/admin/integrations", label: "Integrations", icon: PlugZap, roles: PLATFORM },
      { path: "/admin/jobs", label: "Jobs", icon: Timer, roles: PLATFORM },
      { path: "/admin/reports", label: "Reports", icon: FileDown, roles: PLATFORM },
    ],
  },
  {
    id: "admin-governance",
    label: "Governance",
    placement: "main",
    items: [
      // SUPER_ADMIN only: PROGRAM_OFFICER has no /v1/users access but the audit log (decided for F0.2-E).
      { path: "/admin/users", label: "Users", icon: Users, roles: ["SUPER_ADMIN"] },
      { path: "/admin/audit", label: "Audit", icon: ScrollText, roles: PLATFORM },
    ],
  },
];

export const NAV: Readonly<Record<Workspace, readonly NavGroup[]>> = {
  merchant: MERCHANT,
  mentorship: MENTORSHIP,
  admin: ADMIN,
};

/** The role's nav: its workspace's groups, each filtered to the items it may see; empty groups dropped. */
export function navFor(role: Role): NavGroup[] {
  return NAV[resolveWorkspace(role)]
    .map((group) => ({ ...group, items: group.items.filter((item) => item.roles.includes(role)) }))
    .filter((group) => group.items.length > 0);
}

/** Every item the role can see, in nav order. */
export function navItemsFor(role: Role): NavItem[] {
  return navFor(role).flatMap((group) => group.items);
}

/** The path of the active item: the LONGEST item path the pathname is at or under. */
export function activeNavPath(pathname: string, items: readonly NavItem[]): string | null {
  let best: string | null = null;
  for (const { path } of items) {
    if ((pathname === path || pathname.startsWith(`${path}/`)) && (best === null || path.length > best.length)) {
      best = path;
    }
  }
  return best;
}

/** Whether the role can reach the till ("New sale" and the mobile centre action). */
export function canSell(role: Role): boolean {
  return navItemsFor(role).some((item) => item.path === "/pos");
}

/** Every nav path in every workspace. */
export function allNavPaths(): string[] {
  return Object.values(NAV).flatMap((groups) => groups.flatMap((group) => group.items.map((item) => item.path)));
}

/** Roles GET /v1/locations admits (its readRoles) — the only roles shown the location selector. */
const LOCATION_READERS: readonly Role[] = [OWNER, MANAGER, ACCOUNTANT, WAREHOUSE, CASHIER, VIEWER];

export function canReadLocations(role: Role): boolean {
  return LOCATION_READERS.includes(role);
}

export interface BottomBar {
  /** The role's top destinations, in nav order. */
  destinations: NavItem[];
  /** A central "New sale" action, where the till is reachable. */
  newSale: boolean;
}

/**
 * The mobile bottom bar: the role's first nav destinations, plus a central New sale when the role
 * sells (the till itself is then the centre, not a tab). Five slots in all, with "More" last.
 */
export function bottomBarFor(role: Role): BottomBar {
  const newSale = canSell(role);
  const items = navItemsFor(role).filter((item) => !(newSale && item.path === "/pos"));
  return { destinations: items.slice(0, newSale ? 3 : 4), newSale };
}
