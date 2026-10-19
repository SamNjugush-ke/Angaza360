// ===========================================================================
// The platform's view of a tenant (Task T-A6.1) — registry metadata only. It is read
// from public.tenants and never reaches into a tenant's schema.
// ===========================================================================

import { platformDb } from "../../db/platform";
import type { SubscriptionStatus, SubscriptionTier, TaxRegime, TenantStatus } from "../../generated/platform/enums";

export interface TenantView {
  readonly id: string;
  readonly name: string;
  readonly subdomain: string;
  readonly businessSector: string | null;
  readonly kraPin: string | null;
  readonly taxRegime: TaxRegime;
  readonly status: TenantStatus;
  readonly subscriptionTier: SubscriptionTier;
  readonly subscriptionStatus: SubscriptionStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const TENANT_VIEW_SELECT = {
  id: true,
  name: true,
  subdomain: true,
  businessSector: true,
  kraPin: true,
  taxRegime: true,
  status: true,
  subscriptionTier: true,
  subscriptionStatus: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class TenantAdminError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "TenantAdminError";
    this.status = status;
  }
}

export async function getTenantView(tenantId: string): Promise<TenantView> {
  const tenant = await platformDb.tenant.findUnique({ where: { id: tenantId }, select: TENANT_VIEW_SELECT });
  if (tenant === null) {
    throw new TenantAdminError(404, "No such tenant.");
  }
  return tenant;
}

export async function listTenantViews(filter: { status: TenantStatus | null }): Promise<TenantView[]> {
  return platformDb.tenant.findMany({
    where: filter.status === null ? {} : { status: filter.status },
    orderBy: [{ createdAt: "desc" }],
    select: TENANT_VIEW_SELECT,
  });
}
