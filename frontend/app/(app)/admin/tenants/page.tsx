import type { Metadata } from "next";
import { Tenants } from "@/components/admin/tenants";
import { adminPermissions, TENANT_STATUS_LABEL, type TenantStatus } from "@/lib/admin/admin";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Tenants" };

async function TenantsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  // Onboarding is the SUPER_ADMIN's; validation and the lifecycle are platform staff's.
  const session = await requireSession();
  // The Command Center's tiles link here filtered (?status=ACTIVE); an unknown value is ignored.
  const { status } = await searchParams;
  const initial = status !== undefined && status in TENANT_STATUS_LABEL ? (status as TenantStatus) : "";
  return <Tenants permissions={adminPermissions(session.role)} initialStatus={initial} />;
}

export default guarded(TenantsPage);
