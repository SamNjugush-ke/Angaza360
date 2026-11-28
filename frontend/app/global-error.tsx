"use client";

import { useEffect } from "react";
import { PRODUCT_NAME } from "@/lib/brand";
import { reportBoundaryError } from "@/lib/errors/report";
import "./globals.css";

// The last resort: the ROOT layout itself failed, so this renders its own <html> and <body>.
// Minimal on purpose — the brand logo, the colours from globals.css, no web fonts and nothing that
// could fail again.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportBoundaryError("global", error), [error]);

  return (
    <html lang="en-KE">
      <body className="bg-background font-sans text-foreground antialiased">
        <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-4 py-10 text-center">
          {/* A plain <img>: next/image is part of what may have failed. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/angaza360-logo.svg" alt={PRODUCT_NAME} width={200} height={44} className="h-10 w-auto" />
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="max-w-sm text-muted-foreground">{PRODUCT_NAME} couldn’t load. Please try again in a moment.</p>
          <div className="flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Try again
            </button>
            {/* A full load on purpose: the client router may be what broke. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              className="inline-flex min-h-11 items-center rounded-md border border-input px-5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Go to your home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
