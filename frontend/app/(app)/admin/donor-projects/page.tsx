import type { Metadata } from "next";
import { DonorProjects } from "@/components/admin/donor";
import { guarded } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "Donor projects" };

function DonorProjectsPage() {
  // Platform staff (SUPER_ADMIN, PROGRAM_OFFICER) — the API's staff guard.
  return <DonorProjects />;
}

export default guarded(DonorProjectsPage);
