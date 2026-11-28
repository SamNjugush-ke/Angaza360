import type { Metadata } from "next";
import { AuthPage } from "@/components/auth/auth-page";
import { ApplicationForm } from "@/components/application/application-form";
import { LegalLinks } from "@/components/legal/legal-links";
import { publicMetadata } from "@/lib/seo";

// Finishing a draft, or making the changes a reviewer asked for. Opened from the status page.
export const metadata: Metadata = {
  ...publicMetadata({ title: "Update your application", description: "Finish or correct your business application.", path: "/application/edit", indexable: false }),
  referrer: "no-referrer",
};

export default function ApplicationEditPage() {
  return (
    <AuthPage wide title="Update your application" description="Your saved details are filled in. Make the changes, then submit again." legal={<LegalLinks />}>
      <ApplicationForm resume />
    </AuthPage>
  );
}
