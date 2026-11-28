import type { Metadata } from "next";
import { GuidedSetup } from "@/components/setup/guided-setup";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Set up your business" };

// The first-login guided setup (M4.5 W2). Under /dashboard, so it inherits the dashboard's access;
// each step's link is offered only to a role that may open it (an owner sees them all).
async function SetupPage() {
  const session = await requireSession();
  return <GuidedSetup role={session.role} businessName={session.tenant?.name ?? "your business"} />;
}

export default guarded(SetupPage);
