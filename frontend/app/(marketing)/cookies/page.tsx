import type { Metadata } from "next";
import { LegalBody } from "@/components/legal/legal-text";
import { LegalPage } from "@/components/legal/legal-page";
import { COOKIE_POLICY } from "@/lib/legal/content";
import { publicMetadata } from "@/lib/seo";

// /cookies — a public, INDEXABLE legal page (M4.5 Wave 2), outside the (app) noindex group like
// the landing, and static. The words are the project's legal copy, verbatim (lib/legal/content.ts).
export const dynamic = "force-static";

export const metadata: Metadata = {
  ...publicMetadata({ title: "Cookie Policy", description: "The cookies Angaza360 uses: strictly necessary ones that run the service, and analytics only with your consent.", path: "/cookies" }),
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <LegalPage title="Cookie Policy" path="/cookies">
      <LegalBody body={COOKIE_POLICY.body} />
    </LegalPage>
  );
}
