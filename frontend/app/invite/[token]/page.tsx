import type { Metadata } from "next";
import { AuthPage } from "@/components/auth/auth-page";
import { InviteAccept } from "@/components/auth/invite-accept";
import { PRODUCT_NAME } from "@/lib/brand";

// The address carries the invitation's single-use secret, so the page is never indexed, has no
// canonical (there is no public URL to point at) and sends no Referer anywhere.
export const metadata: Metadata = {
  title: "Accept your invitation",
  description: `Accept your invitation to ${PRODUCT_NAME} and set your password.`,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

interface InvitePageProps {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  return (
    <AuthPage title="Accept your invitation" description="Set up your account to start working in the business you were invited to.">
      <InviteAccept token={token} />
    </AuthPage>
  );
}
