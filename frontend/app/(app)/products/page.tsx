import type { Metadata } from "next";
import { Catalog } from "@/components/catalog/catalog";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Products & services" };

async function ProductsPage() {
  // The request-memoised session the layout and the guard already read; the role decides which
  // write controls the catalog renders (mirroring the backend's guards).
  const session = await requireSession();
  return <Catalog role={session.role} />;
}

export default guarded(ProductsPage);
