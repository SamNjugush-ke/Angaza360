import type { Metadata } from "next";
import { LegalBody } from "@/components/legal/legal-text";
import { LegalPage } from "@/components/legal/legal-page";
import { CONTACT } from "@/lib/legal/content";
import { publicMetadata } from "@/lib/seo";

// /contact — how to reach the operator. Public and INDEXABLE. The words are the project's legal
// copy, verbatim (lib/legal/content.ts).
export const dynamic = "force-static";

export const metadata: Metadata = {
  ...publicMetadata({
    title: "Contact",
    description: "How to reach Angaza360 for support, billing, privacy requests, security reports and complaints.",
    path: "/contact",
  }),
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <LegalPage title="Contact" path="/contact">
      <LegalBody body={CONTACT.body} />
    </LegalPage>
  );
}
