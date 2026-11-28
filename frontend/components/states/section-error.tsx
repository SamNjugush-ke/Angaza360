"use client";

import { usePathname, useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";
import { ErrorState } from "@/components/states/states";
import { reportBoundaryError } from "@/lib/errors/report";
import { routeAccessFor } from "@/lib/nav/access";

// The error boundary of a DATA section (dashboard, sales, payroll …): the section's own failure,
// shown with the shared ErrorState primitive and a retry, while the shell and the rest of the app
// keep working. The section's name comes from the nav config, like everything else about routes.
export function SectionError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const section = routeAccessFor(usePathname())?.label ?? "this section";
  useEffect(() => reportBoundaryError("section", error), [error]);

  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl font-semibold">{section}</h1>
      <ErrorState
        title={`Couldn’t load ${section}`}
        description="Something went wrong while loading this section. Your data is safe — try again."
        onRetry={() =>
          startTransition(() => {
            router.refresh();
            reset();
          })
        }
      />
    </div>
  );
}
