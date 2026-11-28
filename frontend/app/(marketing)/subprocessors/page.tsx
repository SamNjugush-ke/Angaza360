import type { Metadata } from "next";
import { LegalBody } from "@/components/legal/legal-text";
import { LegalPage } from "@/components/legal/legal-page";
import { SUBPROCESSORS } from "@/lib/legal/content";
import { publicMetadata } from "@/lib/seo";

// /subprocessors — reachable only through in-text cross-links (not in footer/sitemap). noindex.
// Copy is verbatim (lib/legal/content.ts).
export const dynamic = "force-static";

export const metadata: Metadata = {
  ...publicMetadata({ title: "Service Providers and Data Transfers", description: "The categories of service providers Angaza360 relies on, and cross-border processing.", path: "/subprocessors" }),
  robots: { index: false, follow: true },
};

export default function Page() {
  return (
    <LegalPage title="Service Providers and Data Transfers" path="/subprocessors">
      <LegalBody body={SUBPROCESSORS.body} />
    </LegalPage>
  );
}
