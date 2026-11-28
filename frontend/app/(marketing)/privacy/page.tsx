import type { Metadata } from "next";
import { LegalBody } from "@/components/legal/legal-text";
import { LegalPage } from "@/components/legal/legal-page";
import { PRIVACY_POLICY } from "@/lib/legal/content";
import { publicMetadata } from "@/lib/seo";

// /privacy — a public, INDEXABLE legal page (M4.5 Wave 2), outside the (app) noindex group like
// the landing, and static. The words are the project's legal copy, verbatim (lib/legal/content.ts).
export const dynamic = "force-static";

export const metadata: Metadata = {
  ...publicMetadata({ title: "Privacy Policy", description: "How Angaza360 collects, uses, shares and protects personal data under the Kenya Data Protection Act 2019, and your rights.", path: "/privacy" }),
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <LegalPage title="Privacy Policy" path="/privacy">
      <LegalBody body={PRIVACY_POLICY.body} />
    </LegalPage>
  );
}
