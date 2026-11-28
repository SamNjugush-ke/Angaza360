import type { Metadata } from "next";
import { ExpensesPayables } from "@/components/expenses/expenses-payables";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Expenses & payables" };

async function ExpensesPage() {
  // The role decides which actions render — recording, bills, payments (owner, manager,
  // accountant) and the suppliers tab (owner, manager) — the API's guards, mirrored.
  const session = await requireSession();
  return <ExpensesPayables role={session.role} />;
}

export default guarded(ExpensesPage);
