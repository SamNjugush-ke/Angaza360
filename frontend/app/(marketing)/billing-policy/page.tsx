import type { Metadata } from "next";
import { LegalBody } from "@/components/legal/legal-text";
import { LegalPage } from "@/components/legal/legal-page";
import { BILLING_POLICY } from "@/lib/legal/content";
import { publicMetadata } from "@/lib/seo";

// /billing-policy — reachable only through in-text cross-links (not in the footer nav or sitemap).
// noindex so it is not surfaced as a standalone result. Copy is verbatim (lib/legal/content.ts).
export const dynamic = "force-static";

export const metadata: Metadata = {
  ...publicMetadata({ title: "Billing, Cancellation and Refund Policy", description: "How Angaza360 subscription charges, cancellations and refunds are handled.", path: "/billing-policy" }),
  robots: { index: false, follow: true },
};

export default function Page() {
  return (
    <LegalPage title="Billing, Cancellation and Refund Policy" path="/billing-policy">
      <LegalBody body={BILLING_POLICY.body} />
    </LegalPage>
  );
}
