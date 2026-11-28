import type { Metadata } from "next";
import { Settings } from "@/components/settings/settings";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Business setup" };

async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  // The role decides which tabs render and whether they are forms or facts: every write and the
  // integrations are the owner's (the API's guards, lib/settings/settings.ts). `?tab=` opens a tab
  // directly — the eTIMS "not set up" panel links to the integrations this way.
  const session = await requireSession();
  const { tab } = await searchParams;
  return <Settings role={session.role} businessName={session.tenant?.name ?? "Your business"} initialTab={typeof tab === "string" ? tab : undefined} />;
}

export default guarded(SettingsPage);
