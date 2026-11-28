import type { Metadata } from "next";
import { Audit } from "@/components/admin/users";
import { guarded } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "Audit" };

function AuditPage() {
  // Platform staff (SUPER_ADMIN, PROGRAM_OFFICER) — GET /v1/users/audit.
  return <Audit />;
}

export default guarded(AuditPage);
