import type { Metadata } from "next";
import { Inventory } from "@/components/inventory/inventory";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Inventory & locations" };

async function InventoryPage() {
  // The role decides which stock actions, location controls and the valuation tab render — the
  // API's guards, mirrored (lib/inventory/inventory.ts).
  const session = await requireSession();
  return <Inventory role={session.role} />;
}

export default guarded(InventoryPage);
