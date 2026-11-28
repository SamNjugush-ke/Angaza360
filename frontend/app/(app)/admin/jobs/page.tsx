import type { Metadata } from "next";
import { Jobs } from "@/components/admin/jobs";
import { adminPermissions } from "@/lib/admin/admin";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Jobs" };

async function JobsPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  // Platform staff read the jobs; only a SUPER_ADMIN (after a step-up) runs one by hand.
  const session = await requireSession();
  const { job } = await searchParams;
  return <Jobs permissions={adminPermissions(session.role)} initialJob={job} />;
}

export default guarded(JobsPage);
