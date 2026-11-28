import type { Metadata } from "next";
import { AuthPage } from "@/components/auth/auth-page";
import { ApplicationStatus } from "@/components/application/application-status";
import { LegalLinks } from "@/components/legal/legal-links";
import { publicMetadata } from "@/lib/seo";

// The applicant's own status page: private to whoever holds the link, so never indexed.
export const metadata: Metadata = {
  ...publicMetadata({ title: "Your application", description: "Where your business application stands.", path: "/application/status", indexable: false }),
  referrer: "no-referrer",
};

export default function ApplicationStatusPage() {
  return (
    <AuthPage wide title="Your application" description="Where your business application stands, and what happens next." legal={<LegalLinks />}>
      <ApplicationStatus />
    </AuthPage>
  );
}
