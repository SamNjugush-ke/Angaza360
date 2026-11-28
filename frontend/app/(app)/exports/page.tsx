import type { Metadata } from "next";
import { Exports } from "@/components/exports/exports";
import { guarded } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "Reports & exports" };

// T-B4 (M4.5 W4): a business exports its own records. The reports listed, their figures and
// whether a role may see them are all decided by GET /v1/report-library.
async function ExportsPage() {
  return <Exports />;
}

export default guarded(ExportsPage);
