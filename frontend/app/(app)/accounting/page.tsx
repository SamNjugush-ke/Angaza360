import type { Metadata } from "next";
import { Accounting } from "@/components/accounting/accounting";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Accounting & reports" };

async function AccountingPage() {
  // The role decides which actions render — posting, reversing and closing (owner, accountant),
  // reopening (owner) — the API's guards, mirrored (lib/accounting/accounting.ts).
  const session = await requireSession();
  return <Accounting role={session.role} />;
}

export default guarded(AccountingPage);
