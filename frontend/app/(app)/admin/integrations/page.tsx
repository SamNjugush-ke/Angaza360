import type { Metadata } from "next";
import { Integrations } from "@/components/admin/integrations";
import { adminPermissions } from "@/lib/admin/admin";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Integrations" };

async function IntegrationsPage() {
  // Business health is platform staff's to read; Angaza's own notification credentials are the SUPER_ADMIN's.
  const session = await requireSession();
  return <Integrations permissions={adminPermissions(session.role)} />;
}

export default guarded(IntegrationsPage);
