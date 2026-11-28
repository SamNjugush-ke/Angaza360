import type { Metadata } from "next";
import { Till } from "@/components/pos/till";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Point of sale" };

async function PosPage() {
  // The request-memoised session the layout and the guard already read. The guard admits only the
  // till roles (OWNER, MANAGER, CASHIER — the nav config); the role decides small things inside.
  const session = await requireSession();
  return <Till role={session.role} />;
}

export default guarded(PosPage);
