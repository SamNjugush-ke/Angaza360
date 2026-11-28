import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { LoginForm } from "@/components/auth/login-form";
import { LoginNotice } from "@/components/auth/login-notice";
import { JsonLd, publicEntryStructuredData } from "@/components/seo/json-ld";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { safeReturnTo } from "@/lib/auth/landing";
import { loginReasonOf } from "@/lib/auth/login-reason";
import { LegalLinks } from "@/components/legal/legal-links";
import { PRODUCT_NAME } from "@/lib/brand";
import { publicMetadata } from "@/lib/seo";

export const metadata: Metadata = publicMetadata({
  title: "Sign in",
  description: `Sign in to ${PRODUCT_NAME} — accounting, point of sale, inventory, payroll and KRA eTIMS for Kenyan businesses.`,
  path: "/login",
});

interface LoginPageProps {
  searchParams: Promise<{ returnTo?: string | string[]; reason?: string | string[] }>;
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const returnTo = safeReturnTo(first(params.returnTo));
  const reason = loginReasonOf(first(params.reason));

  return (
    <>
      <LoginNotice reason={reason} />
      <JsonLd data={publicEntryStructuredData()} />
      <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))]">
        <Image
          src="/brand/angaza360-logo-stacked.svg"
          alt={PRODUCT_NAME}
          width={272}
          height={208}
          priority
          unoptimized
          className="h-auto w-44 sm:w-52"
        />
        <Card className="w-full max-w-md">
          <CardHeader>
            <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight">Login to your account</h1>
            <CardDescription>
              Enter your email and password
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <LoginForm returnTo={returnTo} />
          </CardContent>
          <CardFooter className="flex-col items-start gap-3 border-t pt-6 text-sm">
            <p>
              New business?{" "}
              <Link
                href="/signup"
                className="inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Apply to open an account
              </Link>
            </p>
            
          </CardFooter>
        </Card>
        <LegalLinks />
      </main>
    </>
  );
}
