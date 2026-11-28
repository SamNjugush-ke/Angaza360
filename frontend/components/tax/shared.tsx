"use client";

import Link from "next/link";
import { useId } from "react";
import { STATUS_LABEL, type InvoiceStatus, type TaxPermissions } from "@/lib/tax/tax";
import { cn } from "@/lib/utils";

/** Where the owner stores and activates the eTIMS credentials and switches eTIMS on. */
export const INTEGRATIONS_HREF = "/settings?tab=integrations";

// Pieces the eTIMS screens share: an invoice's status badge and the "eTIMS is not set up" panel,
// which always names the next step — a business that has not set eTIMS up has done nothing wrong
// (its sales finalize normally without it), so this is never a dead end.

const TONE: Readonly<Record<InvoiceStatus, string>> = {
  SIGNED: "border-emerald-700/40 bg-emerald-700/10",
  PENDING: "border-amber-600/40 bg-amber-500/10",
  QUEUED: "border-amber-600/40 bg-amber-500/10",
  REJECTED: "border-destructive/40 bg-destructive/10",
  FAILED: "border-destructive/40 bg-destructive/10",
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  return <span className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-medium", TONE[status])}>{STATUS_LABEL[status]}</span>;
}

export function NotSetUp({ permissions, detail }: { permissions: TaxPermissions; detail?: string }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="space-y-2 rounded-lg border border-amber-600/40 bg-amber-500/10 p-4 text-sm">
      <h2 id={heading} className="font-medium">
        KRA eTIMS is not set up for this business yet
      </h2>
      <p>Sales still finalize normally without it — a KRA invoice is only needed when a customer asks for one. Each business files under its own KRA PIN; there is no shared signer.</p>
      {permissions.canInitialize ? (
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Store the business’s own eTIMS (OSCU) credentials from KRA — TIN, branch and device serial — in{" "}
            <Link href={INTEGRATIONS_HREF} className="font-medium text-primary underline underline-offset-4">
              Business setup → Integrations
            </Link>
            , and activate them.
          </li>
          <li>Switch eTIMS on there.</li>
          <li>Initialize the device on the Device tab. After that, sales can be filed.</li>
        </ol>
      ) : (
        <p>Ask the business owner to set it up: they store and activate the business’s eTIMS credentials, switch eTIMS on, and initialize the device.</p>
      )}
      {detail ? <p className="text-xs text-muted-foreground">KRA eTIMS said: {detail}</p> : null}
    </section>
  );
}
