import type { Metadata } from "next";
import { AuthPage } from "@/components/auth/auth-page";
import { InviteCodeForm } from "@/components/auth/invite-code-form";
import { PRODUCT_NAME } from "@/lib/brand";
import { publicMetadata } from "@/lib/seo";

export const metadata: Metadata = {
  ...publicMetadata({
    title: "Accept an invitation",
    description: `Enter the invitation code you received to join a business on ${PRODUCT_NAME}.`,
    path: "/invite",
    indexable: false,
  }),
  referrer: "no-referrer",
};

export default function InviteCodePage() {
  return (
    <AuthPage title="Accept an invitation" description="Enter the invitation code from the email or SMS you received.">
      <InviteCodeForm />
    </AuthPage>
  );
}
