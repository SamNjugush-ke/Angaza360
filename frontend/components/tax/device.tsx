"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Done } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDateTime } from "@/lib/datetime";
import { initializeDevice, isNotSetUp, useDevice, useInvalidateTax, type TaxPermissions } from "@/lib/tax/tax";
import { INTEGRATIONS_HREF, NotSetUp } from "./shared";

// The business's own OSCU device: its non-secret identity, whether KRA has initialized it, and the
// last invoice number it issued. Initializing asks KRA for the communication key every invoice
// carries and stores it in the business's encrypted credentials — never shown, never returned.
// Reading is the owner's and the accountant's; initializing is the owner's alone.

function Initialize({ again, permissions, onDone }: { again: boolean; permissions: TaxPermissions; onDone: (note: string) => void }) {
  const ids = { title: useId() };
  const invalidate = useInvalidateTax();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      const result = await initializeDevice();
      await invalidate();
      setAsking(false);
      onDone(`Device initialized with KRA (${result.environment.toLowerCase()}). The communication key is stored with the business’s credentials.`);
    } catch (failure) {
      setError(failure);
    } finally {
      setSaving(false);
    }
  }
  const failure = error ? (
    isNotSetUp(error) ? (
      <NotSetUp permissions={permissions} detail={(error as ApiHttpError).message} />
    ) : (
      <p role="alert" className="text-sm text-destructive">
        {error instanceof ApiHttpError ? error.message : "The device could not be initialized. Please try again."}
      </p>
    )
  ) : null;
  if (!asking) {
    return (
      <div className="space-y-2">
        {failure}
        <Button type="button" className="h-11" onClick={() => setAsking(true)}>
          {again ? "Initialize again" : "Initialize the device"}
        </Button>
      </div>
    );
  }
  return (
    <div role="alertdialog" aria-labelledby={ids.title} className="space-y-2 rounded-md border p-3">
      <p id={ids.title} className="font-medium">
        {again ? "Initialize the device again?" : "Initialize the device with KRA?"}
      </p>
      <p className="text-sm">The business will file KRA invoices under its own KRA PIN, from the credentials it has stored. Do this at setup, or when KRA’s key has expired.</p>
      {failure}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving} data-autofocus>
          Back
        </Button>
        <Button type="button" className="h-11" onClick={() => void confirm()} disabled={saving}>
          {saving ? "Contacting KRA…" : "Yes, initialize"}
        </Button>
      </div>
    </div>
  );
}

export function DeviceView({ permissions }: { permissions: TaxPermissions }) {
  const device = useDevice(permissions.canReadDevice);
  const [notice, setNotice] = useState<string | null>(null);
  if (device.isPending) return <LoadingState label="Loading the device" lines={3} />;
  if (device.isError) return <ErrorState title="Couldn’t load the device" description={device.error.message} onRetry={() => void device.refetch()} />;
  const d = device.data;
  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      {d === null ? (
        <section aria-labelledby="no-device" className="space-y-2 text-sm">
          <h2 id="no-device" className="font-medium">
            No eTIMS device yet
          </h2>
          <p>That is the normal state for a business that does not file KRA invoices — its sales finalize normally.</p>
          {permissions.canInitialize ? (
            <p>
              To start filing: store and activate the business’s own eTIMS credentials from KRA in{" "}
              <Link href={INTEGRATIONS_HREF} className="font-medium text-primary underline underline-offset-4">
                Business setup → Integrations
              </Link>
              , switch eTIMS on there, then initialize the device here.
            </p>
          ) : (
            <p>The business owner initializes the device once the business’s eTIMS credentials are stored.</p>
          )}
        </section>
      ) : (
        <dl aria-label="eTIMS device" className="max-w-lg text-sm">
          {[
            ["KRA PIN (TIN)", d.tin],
            ["Branch", d.bhfId],
            ["Device serial", d.dvcSrlNo],
            ["Initialized with KRA", d.initialized ? `Yes${d.lastInitAt ? `, ${formatDateTime(d.lastInitAt)}` : ""}` : "Not yet"],
            ["Last invoice number", d.lastInvoiceNo.toString()],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right font-mono text-xs">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {permissions.canInitialize ? <Initialize again={d?.initialized === true} permissions={permissions} onDone={setNotice} /> : null}
    </div>
  );
}
