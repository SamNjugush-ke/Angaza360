import type { Metadata } from "next";
import { Applications } from "@/components/admin/applications";
import { adminPermissions, APPLICATION_STATUS_LABEL, type ApplicationStatus } from "@/lib/admin/admin";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Applications" };

async function ApplicationsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  // Approve and commit are the SUPER_ADMIN's; review, reject and batch preparation are platform staff's.
  const session = await requireSession();
  // The Command Center's pipeline links here filtered (?status=SUBMITTED); drafts are never staff's.
  const { status } = await searchParams;
  const initial = status !== undefined && status !== "DRAFT" && status in APPLICATION_STATUS_LABEL ? (status as ApplicationStatus) : undefined;
  return <Applications permissions={adminPermissions(session.role)} selfId={session.user.id} initialStatus={initial} />;
}

export default guarded(ApplicationsPage);
