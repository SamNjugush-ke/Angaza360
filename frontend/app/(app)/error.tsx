"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { reportBoundaryError } from "@/lib/errors/report";

// A page in the authenticated area failed to render. Shown INSIDE the shell (the (app) layout
// stays), so the user keeps their navigation: try the page again, or go to their home ("/" sends
// each role to its own landing).
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => reportBoundaryError("app", error), [error]);

  return (
    <section aria-labelledby="app-error-title" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 p-8 text-center">
      <AlertTriangle className="size-8 text-destructive" aria-hidden />
      <h1 id="app-error-title" className="font-display text-xl font-semibold">
        Something went wrong
      </h1>
      <p className="max-w-sm text-sm text-muted-foreground">This page couldn’t be shown. Try again, or go back to your home.</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button
          type="button"
          className="min-h-11"
          onClick={() =>
            startTransition(() => {
              router.refresh();
              reset();
            })
          }
        >
          Try again
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link href="/">Go to your home</Link>
        </Button>
      </div>
    </section>
  );
}
