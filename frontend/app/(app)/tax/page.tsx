import type { Metadata } from "next";
import { Tax } from "@/components/tax/tax";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "KRA eTIMS & tax" };

async function TaxPage() {
  // The role decides which actions render — filing (owner, manager, accountant), resubmitting and
  // credit notes (owner, accountant), the device (owner, accountant; initializing, the owner) — the
  // API's guards, mirrored (lib/tax/tax.ts).
  const session = await requireSession();
  return <Tax role={session.role} />;
}

export default guarded(TaxPage);
