"use client";

import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import {
  consoleKeys,
  PROVIDER_LABEL,
  setPlatformCredentialActive,
  storePlatformCredential,
  useHealth,
  usePlatformCredentials,
  verifyPlatformCredential,
  type CredentialField,
  type CredentialSlot,
  type PlatformEnvironment,
  type PlatformProvider,
} from "@/lib/admin/console";
import type { AdminPermissions } from "@/lib/admin/admin";
import { formatDateTime } from "@/lib/datetime";
import { Ago, healthTone, Panel, StatusMark, useStepUp } from "./console/kit";
import { Confirm, ErrorLine, message, Page } from "./shared";

// INTEGRATIONS (M4.5 W5), in two halves that never touch:
//   * BUSINESS INTEGRATIONS — a READ-ONLY health board from the platform mirror: each business's
//     last check of its M-Pesa / eTIMS credentials and the error, if any. A platform administrator
//     never sees, activates or verifies a business's keys and never decides its Go-Live: those are the
//     owner's (the owner's-keys law). There is no control here that could.
//   * PLATFORM NOTIFICATIONS — Angaza's OWN SMTP, Africa's Talking and SendGrid credentials
//     (SUPER_ADMIN only): status and last check per environment, store / rotate (secrets are
//     write-only password inputs, cleared once stored; the API never returns a value, so none is ever
//     shown), activate and deactivate (after a fresh step-up), and verify (sends nothing).

function BusinessHealthBoard() {
  const statusId = useId();
  const [status, setStatus] = useState<"" | "HEALTHY" | "FAILING">("");
  const health = useHealth({ status });
  const rows = health.data?.data ?? [];
  return (
    <Panel title="Business integrations" description="Each business’s last check of its own M-Pesa and eTIMS credentials. Read-only: the keys and going live are the owner’s.">
      <div className="space-y-3">
        <div className="sm:w-56">
          <SelectField id={statusId} label="Health" value={status} onChange={(v) => setStatus(v as "" | "HEALTHY" | "FAILING")}>
            <option value="">Every check</option>
            <option value="FAILING">Failing</option>
            <option value="HEALTHY">Healthy</option>
          </SelectField>
        </div>
        {health.isPending ? <LoadingState label="Loading integration health" lines={3} /> : null}
        {health.isError ? <ErrorState title="Couldn’t load integration health" description={health.error.message} onRetry={() => void health.refetch()} /> : null}
        {health.isSuccess && rows.length === 0 ? <EmptyState title={status ? "Nothing matches" : "No checks yet"} description="A business appears here once its owner checks an integration." /> : null}
        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Business integration health</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">Business</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Integration</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Health</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Last check</th>
                  <th scope="col" className="py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.tenantId}-${row.provider}-${row.environment}`} className="border-b align-top last:border-b-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <Link href={`/admin/tenants/${encodeURIComponent(row.tenantId)}`} className="font-medium text-primary underline-offset-4 hover:underline">
                        {row.businessName ?? row.tenantId}
                      </Link>
                    </th>
                    <td className="py-2 pr-3">
                      {PROVIDER_LABEL[row.provider] ?? row.provider} <span className="text-xs text-muted-foreground">{row.environment.toLowerCase()}</span>
                    </td>
                    <td className="py-2 pr-3">
                      <StatusMark tone={healthTone(row.status)}>{row.status.toLowerCase()}</StatusMark>
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      <Ago at={row.lastCheckAt} />
                    </td>
                    <td className="py-2 text-xs">{row.lastError ?? <span className="text-muted-foreground">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function StoreForm({ provider, environment, fields, onDone, onCancel }: { provider: PlatformProvider; environment: PlatformEnvironment; fields: readonly CredentialField[]; onDone: (note: string) => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const { guard, prompt } = useStepUp();
  const labelId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const missing = fields.filter((f) => f.required && (values[f.key] ?? "").trim() === "");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (missing.length > 0) return;
    setBusy(true);
    setError(null);
    const sent = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
    try {
      await guard(async () => {
        await storePlatformCredential(provider, environment, sent, label.trim() || undefined);
        setValues({});
        await queryClient.invalidateQueries({ queryKey: consoleKeys.all });
        onDone(`${PROVIDER_LABEL[provider] ?? provider} (${environment}) is stored and waiting to be switched on. Verify it, then activate it.`);
      });
    } catch (failure) {
      // The secrets stay in the form only so they can be corrected; they are never shown back by the server.
      setError(message(failure, "The credential could not be stored. Nothing was saved."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <form aria-label={`Store ${PROVIDER_LABEL[provider] ?? provider} ${environment} credentials`} onSubmit={(e) => void submit(e)} className="space-y-3 rounded-md border p-3" autoComplete="off">
        <p className="text-xs text-muted-foreground">Storing replaces what is there and leaves it switched OFF until you activate it. Secret fields are never shown again — not here, not anywhere.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <FieldInput key={f.key} field={f} value={values[f.key] ?? ""} onChange={(v) => setValues((now) => ({ ...now, [f.key]: v }))} />
          ))}
        </div>
        <TextField id={labelId} label="Label" optional hint="A note for yourself, e.g. “Mailgun, Nov 2026”. Not a secret." value={label} onChange={(e) => setLabel(e.target.value)} />
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="h-11" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" className="h-11" disabled={busy || missing.length > 0 || prompt !== null}>
            {busy ? "Storing…" : "Store credentials"}
          </Button>
        </div>
      </form>
      {prompt}
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: CredentialField; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <TextField
      id={id}
      label={field.label}
      optional={!field.required}
      type={field.secret ? "password" : "text"}
      autoComplete={field.secret ? "new-password" : "off"}
      hint={field.secret ? "Write-only." : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function CredentialCell({ slot, fields, sendsFrom }: { slot: CredentialSlot; fields: readonly CredentialField[]; sendsFrom: string }) {
  const queryClient = useQueryClient();
  const { guard, prompt } = useStepUp();
  const provider = slot.provider as PlatformProvider;
  const environment = slot.environment as PlatformEnvironment;
  const c = slot.credential;
  const [storing, setStoring] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: consoleKeys.all });
  async function act(what: "verify" | "activate" | "deactivate") {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (what === "verify") {
        const result = await verifyPlatformCredential(provider, environment);
        setNote(result.ok ? `Verified: ${result.detail}` : `The check failed: ${result.detail}`);
        await refresh();
      } else {
        await guard(async () => {
          await setPlatformCredentialActive(provider, environment, what === "activate");
          setDeactivating(false);
          setNote(what === "activate" ? "Switched on." : "Switched off.");
          await refresh();
        });
      }
    } catch (failure) {
      setError(message(failure, "That could not be done."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={`${PROVIDER_LABEL[provider] ?? provider} ${environment}`} className="space-y-2 rounded-md border p-3 text-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium capitalize">
          {environment}
          {environment === sendsFrom ? <span className="ml-2 rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs font-medium normal-case text-primary">this deployment sends from here</span> : null}
        </span>
        {c ? (
          <span className="flex items-center gap-3">
            <StatusMark tone={c.status === "ACTIVE" ? "ok" : "idle"}>{c.status.toLowerCase()}</StatusMark>
            <StatusMark tone={healthTone(c.healthStatus)}>{c.healthStatus.toLowerCase()}</StatusMark>
          </span>
        ) : (
          <StatusMark tone="idle">not stored</StatusMark>
        )}
      </header>
      {c ? (
        <dl className="grid gap-x-4 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-2">
          <div>
            <dt className="inline">Label: </dt>
            <dd className="inline text-foreground">{c.label ?? "—"}</dd>
          </div>
          <div>
            <dt className="inline">Last check: </dt>
            <dd className="inline text-foreground">{c.lastHealthCheckAt ? formatDateTime(c.lastHealthCheckAt) : "never"}</dd>
          </div>
          <div>
            <dt className="inline">Stored: </dt>
            <dd className="inline text-foreground">{formatDateTime(c.updatedAt)}</dd>
          </div>
          {c.lastHealthError ? (
            <div className="sm:col-span-2">
              <dt className="inline">Last error: </dt>
              <dd className="inline text-destructive">{c.lastHealthError}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {note ? <p className="text-xs" role="status">{note}</p> : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {storing ? (
        <StoreForm provider={provider} environment={environment} fields={fields} onCancel={() => setStoring(false)} onDone={(n) => { setStoring(false); setNote(n); }} />
      ) : deactivating ? (
        <Confirm title={`Switch off ${PROVIDER_LABEL[provider] ?? provider} (${environment})?`} yes="Yes, switch it off" busy={busy} destructive onBack={() => setDeactivating(false)} onYes={() => void act("deactivate")}>
          <p>{environment === sendsFrom ? "The platform stops sending through it at once — invitations, reset codes and status messages that use it will fail until another credential is active." : "It stops being usable until it is activated again."}</p>
        </Confirm>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="h-11" onClick={() => setStoring(true)} disabled={busy}>
            {c ? "Replace credentials" : "Store credentials"}
          </Button>
          {c ? (
            <Button type="button" variant="outline" className="h-11" onClick={() => void act("verify")} disabled={busy}>
              {busy ? "Checking…" : "Verify"}
            </Button>
          ) : null}
          {c && c.status !== "ACTIVE" ? (
            <Button type="button" className="h-11" onClick={() => void act("activate")} disabled={busy}>
              Activate
            </Button>
          ) : null}
          {c && c.status === "ACTIVE" ? (
            <Button type="button" variant="outline" className="h-11" onClick={() => setDeactivating(true)} disabled={busy}>
              Deactivate
            </Button>
          ) : null}
        </div>
      )}
      {prompt}
    </section>
  );
}

function PlatformNotifications() {
  const credentials = usePlatformCredentials();
  return (
    <Panel title="Platform notifications" description="Angaza’s own email and SMS credentials — what invitations, reset codes and status messages are sent with.">
      {credentials.isPending ? <LoadingState label="Loading platform credentials" lines={3} /> : null}
      {credentials.isError ? <ErrorState title="Couldn’t load the platform credentials" description={credentials.error.message} onRetry={() => void credentials.refetch()} /> : null}
      {credentials.data ? (
        <div className="space-y-5">
          {(["SMTP", "AFRICASTALKING", "SENDGRID"] as const).map((provider) => (
            <div key={provider} className="space-y-2">
              <h3 className="text-sm font-semibold">{PROVIDER_LABEL[provider]}</h3>
              <div className="grid gap-3 lg:grid-cols-2">
                {credentials.data.data
                  .filter((slot) => slot.provider === provider)
                  .sort((a, b) => (a.environment === "production" ? 1 : 0) - (b.environment === "production" ? 1 : 0))
                  .map((slot) => (
                    <CredentialCell key={`${slot.provider}-${slot.environment}`} slot={slot} fields={credentials.data.fields[provider] ?? []} sendsFrom={credentials.data.activeEnvironment} />
                  ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

export function Integrations({ permissions }: { permissions: AdminPermissions }) {
  return (
    <Page title="Integrations" intro="Business integration health, and the platform’s own notification credentials.">
      <BusinessHealthBoard />
      {permissions.isSuperAdmin ? <PlatformNotifications /> : <p className="text-sm text-muted-foreground">The platform’s own notification credentials are managed by a super-administrator.</p>}
    </Page>
  );
}
