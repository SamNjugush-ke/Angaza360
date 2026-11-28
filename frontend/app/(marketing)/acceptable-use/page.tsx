import type { Metadata } from "next";
import { LegalBody } from "@/components/legal/legal-text";
import { LegalPage } from "@/components/legal/legal-page";
import { ACCEPTABLE_USE_POLICY } from "@/lib/legal/content";
import { publicMetadata } from "@/lib/seo";

// /acceptable-use — a public, INDEXABLE legal page (M4.5 Wave 2), outside the (app) noindex group like
// the landing, and static. The words are the project's legal copy, verbatim (lib/legal/content.ts).
export const dynamic = "force-static";

export const metadata: Metadata = {
  ...publicMetadata({ title: "Acceptable Use Policy", description: "What you may not do when using Angaza360, and how to report abuse.", path: "/acceptable-use" }),
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <LegalPage title="Acceptable Use Policy" path="/acceptable-use">
      <LegalBody body={ACCEPTABLE_USE_POLICY.body} />
    </LegalPage>
  );
}
