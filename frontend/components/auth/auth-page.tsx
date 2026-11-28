import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { PRODUCT_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

// The frame every public account page shares with the sign-in page: the stacked logo above one
// card with a single <h1>, and a way back to sign in.

export const LINK_CLASS =
  "inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export interface AuthPageProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** A wider card for a longer form (the business application). */
  wide?: boolean;
  /** Shown under the card (the legal pages' links). */
  legal?: ReactNode;
}

export function AuthPage({ title, description, children, footer, wide = false, legal }: AuthPageProps) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))]">
      <Link href="/login" aria-label={`${PRODUCT_NAME} — sign in`} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Image
          src="/brand/angaza360-logo-stacked.svg"
          alt={PRODUCT_NAME}
          width={272}
          height={208}
          priority
          unoptimized
          className="h-auto w-36 sm:w-44"
        />
      </Link>
      <Card className={cn("w-full", wide ? "max-w-2xl" : "max-w-md")}>
        <CardHeader>
          <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight">{title}</h1>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-5">{children}</CardContent>
        <CardFooter className="flex-col items-start gap-3 border-t pt-6 text-sm">
          {footer ?? (
            <Link href="/login" className={LINK_CLASS}>
              Back to sign in
            </Link>
          )}
        </CardFooter>
      </Card>
      {legal ?? null}
    </main>
  );
}
