import { platformDb } from "../db/platform";
import { assertValidSchemaName } from "../db/tenant";
import type {
  SubscriptionTier,
  TenantStatus,
} from "../generated/platform/enums";

export interface TenantContext {
  tenantId: string;
  subdomain: string;
  dbSchema: string;
  status: TenantStatus;
  subscriptionTier: SubscriptionTier;
}

// Thrown when a tenant referenced by a valid session cannot be used: it no
// longer exists, or its status is not ACTIVE (suspended/deactivated). Routes
// map this to 403. Distinct and catchable so callers can branch on it.
export class TenantUnavailableError extends Error {
  readonly tenantId: string;
  readonly reason: "NOT_FOUND" | "NOT_ACTIVE";
  constructor(tenantId: string, reason: "NOT_FOUND" | "NOT_ACTIVE", message: string) {
    super(message);
    this.name = "TenantUnavailableError";
    this.tenantId = tenantId;
    this.reason = reason;
  }
}

interface CacheEntry {
  value: TenantContext;
  expiresAt: number;
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;

// Memoised tenant lookups. A suspended tenant loses access within TTL_MS
// because entries are re-validated against public.tenants once they expire.
const cache = new Map<string, CacheEntry>();

export function invalidateTenantContext(tenantId: string): void {
  cache.delete(tenantId);
}

export function clearTenantRegistryCache(): void {
  cache.clear();
}

export async function resolveTenantContext(
  tenantId: string,
): Promise<TenantContext> {
  const now = Date.now();
  const cached = cache.get(tenantId);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached !== undefined) {
    cache.delete(tenantId);
  }

  const tenant = await platformDb.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      subdomain: true,
      dbSchema: true,
      status: true,
      subscriptionTier: true,
    },
  });

  if (tenant === null) {
    throw new TenantUnavailableError(
      tenantId,
      "NOT_FOUND",
      `Tenant ${tenantId} does not exist.`,
    );
  }

  if (tenant.status !== "ACTIVE") {
    throw new TenantUnavailableError(
      tenantId,
      "NOT_ACTIVE",
      `Tenant ${tenantId} is not active (status: ${tenant.status}).`,
    );
  }

  // The registry is trusted, but this is the last gate before the schema name
  // is handed to a query — never skip it.
  assertValidSchemaName(tenant.dbSchema);

  const value: TenantContext = {
    tenantId: tenant.id,
    subdomain: tenant.subdomain,
    dbSchema: tenant.dbSchema,
    status: tenant.status,
    subscriptionTier: tenant.subscriptionTier,
  };

  // Enforce the cap with simple FIFO eviction before inserting.
  if (cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(tenantId, { value, expiresAt: now + TTL_MS });

  return value;
}
