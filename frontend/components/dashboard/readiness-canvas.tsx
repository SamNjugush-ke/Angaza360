"use client";

import { CheckCircle2, Circle } from "lucide-react";
import Link from "next/link";
import type { Role } from "@/lib/auth/landing";
import { actionFor } from "@/lib/dashboard/attention";
import { fixFor } from "@/lib/dashboard/readiness";
import type { Readiness } from "@/lib/dashboard/types";
import { cn } from "@/lib/utils";

const actionClass =
  "inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/** Getting the business ready to trade: the backend's own checks, each with where to fix it. */
export function ReadinessCanvas({ role, readiness }: { role: Role; readiness: Readiness }) {
  const required = readiness.checks.filter((check) => check.required);
  const recommended = readiness.checks.filter((check) => !check.required);
  const done = required.filter((check) => check.pass).length;
  const firstSale = readiness.readyToTrade ? fixFor(role, "FIRST_SALE") : undefined;
  const setup = actionFor(role, "Follow the guided setup", "/dashboard/setup");

  const list = (checks: Readiness["checks"]) => (
    <ul className="divide-y rounded-lg border bg-card">
      {checks.map((check) => {
        // Once ready, the first sale is offered once — in the banner above.
        const offeredAbove = readiness.readyToTrade && check.key === "FIRST_SALE";
        const fix = check.pass || offeredAbove ? undefined : fixFor(role, check.key);
        return (
          <li key={check.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              {check.pass ? (
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              ) : (
                <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <div>
                <p className="font-medium">
                  {check.label}
                  <span className="sr-only">{check.pass ? " — done" : " — to do"}</span>
                </p>
                <p className="text-sm text-muted-foreground">{check.detail}</p>
              </div>
            </div>
            {fix ? (
              <Link href={fix.href} className={cn(actionClass, "border border-input bg-background hover:bg-muted")}>
                {fix.label}
              </Link>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="space-y-6">
      {readiness.readyToTrade ? (
        <section aria-labelledby="ready-title" className="flex flex-col gap-3 rounded-lg border border-success/40 bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="ready-title" className="font-display text-lg font-semibold">
              You’re ready — record your first sale
            </h2>
            <p className="text-sm text-muted-foreground">Everything required is in place. Your dashboard fills in from your first sale.</p>
          </div>
          {firstSale ? (
            <Link href={firstSale.href} className={cn(actionClass, "bg-primary text-primary-foreground hover:bg-primary/90")}>
              {firstSale.label}
            </Link>
          ) : null}
        </section>
      ) : (
        <section aria-labelledby="setup-title" className="space-y-1">
          <h2 id="setup-title" className="font-display text-lg font-semibold">
            Get ready to trade
          </h2>
          <p className="text-sm text-muted-foreground">
            {done} of {required.length} required steps done. Your dashboard fills in once you start selling.
          </p>
          {setup ? (
            <Link href={setup.href} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
              {setup.label}
            </Link>
          ) : null}
        </section>
      )}
      <section aria-labelledby="required-title" className="space-y-3">
        <h3 id="required-title" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Required
        </h3>
        {list(required)}
      </section>
      <section aria-labelledby="recommended-title" className="space-y-3">
        <h3 id="recommended-title" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Recommended
        </h3>
        {list(recommended)}
      </section>
    </div>
  );
}
