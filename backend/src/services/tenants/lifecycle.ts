// ===========================================================================
// The tenant LIFECYCLE (Task T-A6.1).
//
//   PENDING_PROVISIONING -> ACTIVE          (provisioning; not an admin action)
//   ACTIVE               -> SUSPENDED       suspendTenant
//   SUSPENDED            -> ACTIVE          reactivateTenant
//   ACTIVE | SUSPENDED   -> DEACTIVATED     deactivateTenant — TERMINAL
//
// The service refuses any other move with a clean 409; the tenant_status_transition_guard
// trigger refuses it for every writer. Each change is audited in the ONE identity audit
// log, in the same transaction.
//
// SUSPENSION LOCKS THE BUSINESS'S USERS OUT through the gate that already exists:
// resolveTenantContext (src/auth/tenant-registry.ts) refuses a non-ACTIVE tenant, so login
// answers 403 and every authenticated request is 403. That gate caches a tenant for up to
// 60s per process, so the change also invalidates this process's cached entry; other
// processes see it within the cache TTL.
// ===========================================================================

import { invalidateTenantContext } from "../../auth/tenant-registry";
import { platformDb } from "../../db/platform";
import type { AuditAction, TenantStatus } from "../../generated/platform/enums";
import { recordAudit } from "../identity/audit";
import type { Actor } from "../identity/user-management";
import { TENANT_VIEW_SELECT, TenantAdminError, type TenantView } from "./tenant-view";

const ALLOWED: ReadonlyArray<readonly [TenantStatus, TenantStatus]> = [
  ["PENDING_PROVISIONING", "ACTIVE"],
  ["ACTIVE", "SUSPENDED"],
  ["SUSPENDED", "ACTIVE"],
  ["ACTIVE", "DEACTIVATED"],
  ["SUSPENDED", "DEACTIVATED"],
];

export function isAllowedTenantTransition(from: TenantStatus, to: TenantStatus): boolean {
  return ALLOWED.some(([a, b]) => a === from && b === to);
}

async function transition(actor: Actor, tenantId: string, to: TenantStatus, action: AuditAction, reason: string | null): Promise<TenantView> {
  const updated = await platformDb.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, status: true, subdomain: true } });
    if (tenant === null) {
      throw new TenantAdminError(404, "No such tenant.");
    }
    if (!isAllowedTenantTransition(tenant.status, to)) {
      throw new TenantAdminError(
        409,
        `The tenant is ${tenant.status}; it cannot become ${to}.${tenant.status === "DEACTIVATED" ? " DEACTIVATED is terminal." : ""}`,
      );
    }
    const row = await tx.tenant.update({ where: { id: tenantId }, data: { status: to }, select: TENANT_VIEW_SELECT });
    await recordAudit(tx, {
      action,
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId,
      ipAddress: actor.ipAddress,
      metadata: { fromStatus: tenant.status, toStatus: to, subdomain: tenant.subdomain, reason },
    });
    return row;
  });
  invalidateTenantContext(tenantId);
  return updated;
}

export function suspendTenant(actor: Actor, tenantId: string, reason: string | null): Promise<TenantView> {
  return transition(actor, tenantId, "SUSPENDED", "TENANT_SUSPENDED", reason);
}

export function reactivateTenant(actor: Actor, tenantId: string, reason: string | null): Promise<TenantView> {
  return transition(actor, tenantId, "ACTIVE", "TENANT_REACTIVATED", reason);
}

export function deactivateTenant(actor: Actor, tenantId: string, reason: string | null): Promise<TenantView> {
  return transition(actor, tenantId, "DEACTIVATED", "TENANT_DEACTIVATED", reason);
}
