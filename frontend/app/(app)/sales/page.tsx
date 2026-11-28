import type { Metadata } from "next";
import { Sales } from "@/components/sales/sales";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Sales & receipts" };

async function SalesPage() {
  // The role decides what the screen offers: the customer filter and names (owner, manager,
  // cashier), "Current shift only" (the till roles) and the void (manager, owner) — the API's guards.
  const session = await requireSession();
  return <Sales role={session.role} />;
}

export default guarded(SalesPage);
