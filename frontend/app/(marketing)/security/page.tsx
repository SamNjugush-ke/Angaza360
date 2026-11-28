import type { Metadata } from "next";
import { LegalBody } from "@/components/legal/legal-text";
import { LegalPage } from "@/components/legal/legal-page";
import { SECURITY } from "@/lib/legal/content";
import { publicMetadata } from "@/lib/seo";

// /security — reachable only through in-text cross-links (not in footer/sitemap). noindex.
// Copy is verbatim (lib/legal/content.ts).
export const dynamic = "force-static";

export const metadata: Metadata = {
  ...publicMetadata({ title: "Security and Responsible Disclosure", description: "How Angaza360 protects information and how to report a security concern.", path: "/security" }),
  robots: { index: false, follow: true },
};

export default function Page() {
  return (
    <LegalPage title="Security and Responsible Disclosure" path="/security">
      <LegalBody body={SECURITY.body} />
    </LegalPage>
  );
}
