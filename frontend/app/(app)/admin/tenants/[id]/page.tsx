import type { Metadata } from "next";
import { BusinessDetail } from "@/components/admin/business-detail";
import { adminPermissions } from "@/lib/admin/admin";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Business" };

async function BusinessPage({ params }: { params: Promise<{ id: string }> }) {
  // Platform staff; the lifecycle and every read are decided again by the API. Support access is
  // requested by a SUPER_ADMIN and read only by the administrator it names.
  const session = await requireSession();
  const { id } = await params;
  return <BusinessDetail tenantId={id} permissions={adminPermissions(session.role)} />;
}

export default guarded(BusinessPage);
