import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard/dashboard";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Dashboard" };

async function DashboardPage() {
  // The same request-memoised session the layout and the guard already read.
  const session = await requireSession();
  const businessName = session.tenant?.name ?? session.tenant?.subdomain ?? "Your business";
  return <Dashboard role={session.role} fullName={session.user.fullName} businessName={businessName} />;
}

export default guarded(DashboardPage);
