import type { Metadata } from "next";
import { Customers } from "@/components/customers/customers";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Customers & receivables" };

async function CustomersPage() {
  // The role decides what renders: the directory (owner, manager, cashier), receivables (owner,
  // manager, accountant, auditor) and the receipt action — the API's guards, mirrored.
  const session = await requireSession();
  return <Customers role={session.role} />;
}

export default guarded(CustomersPage);
