import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/brand";

// The branded 404 for any path with no page. Outside the shell, so it reads the same signed in
// or out; "/" then sends each visitor on (their workspace, or sign-in). Next adds noindex.
export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <Image src="/brand/angaza360-logo.svg" alt={PRODUCT_NAME} width={200} height={44} unoptimized className="h-10 w-auto" />
      <p className="font-mono text-sm font-medium text-muted-foreground">404</p>
      <h1 className="font-display text-2xl font-semibold">Page not found</h1>
      <p className="max-w-sm text-muted-foreground">The page you asked for doesn’t exist, or it has moved.</p>
      <Link
        href="/"
        className="inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Go to your home
      </Link>
    </main>
  );
}
