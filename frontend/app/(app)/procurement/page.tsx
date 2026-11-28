import type { Metadata } from "next";
import { Procurement } from "@/components/procurement/procurement";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Procurement" };

async function ProcurementPage() {
  // The role decides which lifecycle steps and the suppliers tab render — the API's guards,
  // mirrored (lib/procurement/procurement.ts).
  const session = await requireSession();
  return <Procurement role={session.role} />;
}

export default guarded(ProcurementPage);
