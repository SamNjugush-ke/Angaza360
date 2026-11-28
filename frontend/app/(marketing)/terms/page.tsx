import type { Metadata } from "next";
import { LegalBody } from "@/components/legal/legal-text";
import { LegalPage } from "@/components/legal/legal-page";
import { TERMS_OF_SERVICE } from "@/lib/legal/content";
import { publicMetadata } from "@/lib/seo";

// /terms — a public, INDEXABLE legal page (M4.5 Wave 2), outside the (app) noindex group like
// the landing, and static. The words are the project's legal copy, verbatim (lib/legal/content.ts).
export const dynamic = "force-static";

export const metadata: Metadata = {
  ...publicMetadata({ title: "Terms of Service", description: "The terms on which Kenyan businesses use Angaza360: accounts, your data, integrations, fees, termination and governing law.", path: "/terms" }),
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <LegalPage title="Terms of Service" path="/terms">
      <LegalBody body={TERMS_OF_SERVICE.body} />
    </LegalPage>
  );
}
