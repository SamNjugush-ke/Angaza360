import type { Role } from "@/lib/auth/landing";

// What each role may do in the catalog — a MIRROR of the backend guards on /v1/products (verified
// against backend/src/routes/products.ts), so the page never offers an action the API refuses:
//   read                                 OWNER, MANAGER, WAREHOUSE_STAFF, CASHIER, VIEWER_AUDITOR
//   create / edit / reorder / import     OWNER, MANAGER, WAREHOUSE_STAFF
//   deactivate / reactivate / tax class  OWNER, MANAGER
// The backend is still the guarantee; this only decides which controls render.

export interface CatalogPermissions {
  canCreate: boolean;
  canEdit: boolean;
  canReorder: boolean;
  canImport: boolean;
  canActivate: boolean;
  canSetTaxClass: boolean;
}

const WRITERS: ReadonlySet<Role> = new Set<Role>(["MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF"]);
const ADMINS: ReadonlySet<Role> = new Set<Role>(["MSME_OWNER", "MSME_MANAGER"]);

export function catalogPermissions(role: Role): CatalogPermissions {
  const writer = WRITERS.has(role);
  const admin = ADMINS.has(role);
  return { canCreate: writer, canEdit: writer, canReorder: writer, canImport: writer, canActivate: admin, canSetTaxClass: admin };
}
