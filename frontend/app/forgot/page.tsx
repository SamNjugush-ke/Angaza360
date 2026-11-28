import type { Metadata } from "next";
import { AuthPage } from "@/components/auth/auth-page";
import { ForgotFlow } from "@/components/auth/forgot-flow";
import { PRODUCT_NAME } from "@/lib/brand";
import { publicMetadata } from "@/lib/seo";

// Not indexed: a recovery step has nothing to rank for. No Referer leaves this page.
export const metadata: Metadata = {
  ...publicMetadata({
    title: "Reset your password",
    description: `Reset the password for your ${PRODUCT_NAME} account with a single-use code sent to your email.`,
    path: "/forgot",
    indexable: false,
  }),
  referrer: "no-referrer",
};

export default function ForgotPasswordPage() {
  return (
    <AuthPage
      title="Reset your password"
      description="Enter the email you sign in with. We’ll send a single-use reset code to it."
    >
      <ForgotFlow />
    </AuthPage>
  );
}
