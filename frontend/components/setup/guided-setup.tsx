"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, MinusCircle } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { Role } from "@/lib/auth/landing";
import { actionFor } from "@/lib/dashboard/attention";
import { getGated, isNotPermitted, withQuery } from "@/lib/dashboard/fetch";
import { useReadiness } from "@/lib/dashboard/hooks";
import type { Readiness } from "@/lib/dashboard/types";
import { applicableSteps, readMarks, stateOf, writeMarks, type SetupMarks, type SetupStepKey } from "@/lib/setup/setup";
import { cn } from "@/lib/utils";

interface ProductPage {
  pagination: { total: number };
}

const linkClass =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

async function productTotal(kind?: "GOOD"): Promise<number | null> {
  const page = await getGated<ProductPage>(withQuery("/products", { take: 1, skip: 0, active: "true", kind }));
  return isNotPermitted(page) ? null : page.pagination.total;
}

/** The guided first-login checklist: every step links to the screen that does it, and can be skipped. */
export function GuidedSetup({ role, businessName }: { role: Role; businessName: string }) {
  const readinessQuery = useReadiness();
  const catalog = useQuery({
    queryKey: ["setup", "catalog"],
    queryFn: async () => ({ all: await productTotal(), goods: await productTotal("GOOD") }),
  });
  // The owner's own done / skipped marks live in this browser; read on the client only (a query
  // runs after hydration, so the server render and the first client render agree).
  const queryClient = useQueryClient();
  const marksQuery = useQuery({ queryKey: ["setup", "marks"], queryFn: () => readMarks(), staleTime: Infinity });
  const marks: SetupMarks = marksQuery.data ?? {};

  const readiness: Readiness | null = readinessQuery.data && !isNotPermitted(readinessQuery.data) ? readinessQuery.data : null;
  const all = catalog.data?.all ?? null;
  const goods = catalog.data?.goods ?? null;
  const steps = applicableSteps((all ?? 0) > 0, all === null || goods === null ? null : goods > 0);
  const states = steps.map((step) => stateOf(step, readiness, marks));
  const finished = states.filter((state) => state !== "todo").length;

  function mark(key: SetupStepKey, value: "done" | "skipped" | null) {
    const next = { ...marks };
    if (value === null) delete next[key];
    else next[key] = value;
    queryClient.setQueryData(["setup", "marks"], next);
    writeMarks(next);
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold">Set up {businessName}</h1>
        <p className="text-sm text-muted-foreground">
          {finished} of {steps.length} steps done or skipped. Take them in any order — skip anything that does not apply, and come back whenever you like.
        </p>
      </header>
      {readinessQuery.isError ? <p className="text-sm text-destructive">We couldn’t check what is already in place. The steps still work.</p> : null}
      <ol className="divide-y rounded-lg border bg-card">
        {steps.map((step, index) => {
          const state = states[index];
          const action = actionFor(role, step.action, step.href);
          const fromBackend = step.check !== undefined && readiness?.checks.find((c) => c.key === step.check)?.pass === true;
          return (
            <li key={step.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                {state === "done" ? (
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
                ) : state === "skipped" ? (
                  <MinusCircle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <div>
                  <p className={cn("font-medium", state === "skipped" && "text-muted-foreground")}>
                    {index + 1}. {step.title}
                    <span className="sr-only">{state === "done" ? " — done" : state === "skipped" ? " — skipped" : " — to do"}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">{step.detail}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {action && state === "todo" ? (
                  <Link href={action.href} className={linkClass}>
                    {action.label}
                  </Link>
                ) : null}
                {state === "todo" ? (
                  <>
                    <Button type="button" variant="ghost" className="h-11" onClick={() => mark(step.key, "done")}>
                      Mark done
                    </Button>
                    <Button type="button" variant="ghost" className="h-11" onClick={() => mark(step.key, "skipped")}>
                      Skip
                    </Button>
                  </>
                ) : !fromBackend ? (
                  <Button type="button" variant="ghost" className="h-11" onClick={() => mark(step.key, null)}>
                    Undo
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-muted-foreground">
        Done for now?{" "}
        <Link href="/dashboard" className="font-medium text-primary underline-offset-4 hover:underline">
          Go to the dashboard
        </Link>
      </p>
    </div>
  );
}
