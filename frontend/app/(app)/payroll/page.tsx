import type { Metadata } from "next";
import { Payroll } from "@/components/payroll/payroll";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Payroll" };

async function PayrollPage() {
  // The role decides which actions render: HR work (employees, draft runs) for the owner, a manager
  // and the HR officer; approving, posting, paying and remitting for the owner and a manager; reads
  // for the accountant and auditor too — the API's guards, mirrored (lib/payroll/payroll.ts).
  const session = await requireSession();
  return <Payroll role={session.role} />;
}

export default guarded(PayrollPage);
