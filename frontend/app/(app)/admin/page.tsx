import type { Metadata } from "next";
import { AdminOverview } from "@/components/admin/overview";
import { adminPermissions } from "@/lib/admin/admin";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Administration" };

async function AdminPage() {
  // Platform staff (SUPER_ADMIN, PROGRAM_OFFICER).
  const session = await requireSession();
  return <AdminOverview permissions={adminPermissions(session.role)} />;
}

export default guarded(AdminPage);
