import { PROTECTED_PREFIXES, ROLE_LANDING, type Role } from "@/lib/auth/landing";
import { NAV } from "./config";
import { resolveWorkspace, WORKSPACE_NAME } from "./workspace";

// Which roles may OPEN each protected path — DERIVED from the nav config, never written down a
// second time. A path the nav shows a role is a path the role may open, and nothing else is:
//   - every nav path admits the union of the roles listed against it in any workspace (so
//     /mentorship admits the owner from the merchant nav and the mentors from their own);
//   - a protected prefix with no nav item of its own (/admin) admits whoever may open something
//     under it;
//   - a path resolves to its LONGEST covering entry, so /mentorship/mentees is the mentors' alone
//     and a new /payroll/runs/123 inherits /payroll;
//   - a path no entry covers admits NOBODY (fail closed);
//   - the SELF-SERVICE prefix /account (your own sign-in security, M4.5 W1) admits every role:
//     it shows only the signed-in person's own settings, and every role has one.
// Like the nav, this only avoids rendering a page the backend would refuse; the backend still
// decides every read and write.

export interface RouteAccess {
  path: string;
  /** What the section is called, for "You don't have access to <label>". */
  label: string;
  roles: readonly Role[];
}

/** Every role's own account pages (M4.5 W1). */
export const SELF_SERVICE_PREFIX = "/account";

function deriveRouteAccess(): RouteAccess[] {
  const byPath = new Map<string, { label: string; roles: Set<Role> }>();
  for (const groups of Object.values(NAV)) {
    for (const item of groups.flatMap((group) => group.items)) {
      // A workspace's own root (/admin — the Command Center's overview, M4.5 W5) is named for the
      // workspace, not its nav label: "You don't have access to Platform administration".
      const workspace = (PROTECTED_PREFIXES as readonly string[]).includes(item.path) ? item.roles.map(resolveWorkspace).find((w) => w !== "merchant") : undefined;
      const entry = byPath.get(item.path) ?? { label: workspace ? WORKSPACE_NAME[workspace] : item.label, roles: new Set<Role>() };
      for (const role of item.roles) entry.roles.add(role);
      byPath.set(item.path, entry);
    }
  }

  byPath.set(SELF_SERVICE_PREFIX, { label: "your account", roles: new Set(Object.keys(ROLE_LANDING) as Role[]) });

  for (const prefix of PROTECTED_PREFIXES) {
    if (byPath.has(prefix)) continue;
    const under = [...byPath.entries()].filter(([path]) => path.startsWith(`${prefix}/`));
    const roles = new Set<Role>(under.flatMap(([, entry]) => [...entry.roles]));
    const workspace = [...roles].map(resolveWorkspace).find((w) => w !== "merchant");
    byPath.set(prefix, { label: workspace ? WORKSPACE_NAME[workspace] : "this section", roles });
  }

  return [...byPath.entries()].map(([path, { label, roles }]) => ({ path, label, roles: [...roles] }));
}

export const ROUTE_ACCESS: readonly RouteAccess[] = deriveRouteAccess();

/** The entry governing a pathname (query ignored): the longest path it is at or under. */
export function routeAccessFor(pathname: string): RouteAccess | null {
  const path = pathname.split(/[?#]/, 1)[0];
  let best: RouteAccess | null = null;
  for (const entry of ROUTE_ACCESS) {
    if ((path === entry.path || path.startsWith(`${entry.path}/`)) && (best === null || entry.path.length > best.path.length)) {
      best = entry;
    }
  }
  return best;
}

export type AccessDecision = { allowed: true } | { allowed: false; section: string };

/** Whether the role may open the pathname; fails closed on a path no entry covers. */
export function decideAccess(role: Role, pathname: string | null): AccessDecision {
  const entry = pathname ? routeAccessFor(pathname) : null;
  if (entry?.roles.includes(role)) return { allowed: true };
  return { allowed: false, section: entry?.label ?? "this section" };
}
