import type { Metadata } from "next";
import { LegalBody } from "@/components/legal/legal-text";
import { LegalPage } from "@/components/legal/legal-page";
import { DATA_PROCESSING_AGREEMENT } from "@/lib/legal/content";
import { publicMetadata } from "@/lib/seo";

// /data-processing-agreement — reachable only through in-text cross-links (not in footer/sitemap).
// noindex. Copy is verbatim (lib/legal/content.ts).
export const dynamic = "force-static";

export const metadata: Metadata = {
  ...publicMetadata({ title: "Data Processing Agreement", description: "How Angaza360 processes business personal data on a customer's behalf.", path: "/data-processing-agreement" }),
  robots: { index: false, follow: true },
};

export default function Page() {
  return (
    <LegalPage title="Data Processing Agreement" path="/data-processing-agreement">
      <LegalBody body={DATA_PROCESSING_AGREEMENT.body} />
    </LegalPage>
  );
}
