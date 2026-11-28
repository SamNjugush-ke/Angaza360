import type { Metadata } from "next";
import Link from "next/link";
import { AuthPage, LINK_CLASS } from "@/components/auth/auth-page";
import { ApplicationForm } from "@/components/application/application-form";
import { LegalLinks } from "@/components/legal/legal-links";
import { PRODUCT_NAME } from "@/lib/brand";
import { publicMetadata } from "@/lib/seo";


export const metadata: Metadata = publicMetadata({
  title: "Apply to open an account",
  description: `Apply to open an ${PRODUCT_NAME} account for your Kenyan business — accounting, POS, inventory, payroll and KRA eTIMS. Every application is reviewed before an account is opened.`,
  path: "/signup",
});

export default function SignupPage() {
  return (
    <AuthPage
      wide
      title="Apply to open an account"
      description={`Tell us about the business and its owner. Every application is reviewed by the ${PRODUCT_NAME} team before an account is opened — nothing is created until then.`}
      footer={
        <p>
          Already have an account?{" "}
          <Link href="/login" className={LINK_CLASS}>
            Sign in
          </Link>
        </p>
      }
      legal={<LegalLinks />}
    >
      <ApplicationForm />
    </AuthPage>
  );
}
