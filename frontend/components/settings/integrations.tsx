"use client";

import { useId, useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/form-bits";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Done } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDateTime } from "@/lib/datetime";
import {
  activateCredential,
  CREDENTIAL_FIELDS,
  CREDENTIAL_STATUS_LABEL,
  ENVIRONMENT_LABEL,
  ENVIRONMENTS,
  PROVIDER_LABEL,
  PROVIDER_PURPOSE,
  saveIntegrationSetting,
  storeCredential,
  useIntegrations,
  useInvalidateSettings,
  type Credential,
  type Environment,
  type Provider,
  type ProviderSummary,
} from "@/lib/settings/settings";
import { cn } from "@/lib/utils";

// INTEGRATIONS — the owner's own provider credentials (M-Pesa, KRA eTIMS), per environment.
// SECRETS ARE WRITE-ONLY: the form sends them once and clears them; the API returns a SAFE view
// (status, label, which key encrypted it) and never a secret, so nothing here could show one back.
// Going live is three steps the server enforces in order: store the production credentials,
// activate them, then switch the provider to Production — it refuses to point at an environment
// with no active credential. A refusal keeps every value typed, so a half-entered credential is
// never lost.

const message = (failure: unknown, fallback: string) => (failure instanceof ApiHttpError ? failure.message : fallback);

function StatusBadge({ status }: { status: Credential["status"] }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full border px-2 py-0.5 text-xs font-medium",
        status === "ACTIVE" ? "border-emerald-700/40 bg-emerald-700/10" : status === "PENDING" ? "border-amber-600/40 bg-amber-500/10" : "border-destructive/40 bg-destructive/10",
      )}
    >
      {CREDENTIAL_STATUS_LABEL[status]}
    </span>
  );
}

function CredentialForm({ provider, environment, replacing, onClose, onStored }: { provider: Provider; environment: Environment; replacing: Credential | null; onClose: () => void; onStored: (note: string) => void }) {
  const prefix = useId();
  const invalidate = useInvalidateSettings();
  const fields = CREDENTIAL_FIELDS[provider] ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState(replacing?.label ?? "");
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    for (const f of fields) if (f.required && (values[f.name] ?? "").trim() === "") found[f.name] = `Enter the ${f.label.toLowerCase()}.`;
    if (provider === "MPESA" && (values.shortcode ?? "").trim() !== "" && !/^\d{5,7}$/.test((values.shortcode ?? "").trim())) found.shortcode = "A shortcode is 5 to 7 digits.";
    if (provider === "ETIMS" && (values.apiBaseUrl ?? "").trim() !== "" && !/^https:\/\//.test((values.apiBaseUrl ?? "").trim())) found.apiBaseUrl = "The address must start with https://.";
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const sent: Record<string, string> = {};
      for (const f of fields) {
        const value = (values[f.name] ?? "").trim();
        if (value !== "") sent[f.name] = value;
      }
      const stored = await storeCredential(provider, { environment, fields: sent, ...(label.trim() !== "" ? { label: label.trim() } : {}) });
      // The secrets leave the page's memory as soon as the server has them.
      setValues({});
      await invalidate();
      onStored(`${PROVIDER_LABEL[provider]} ${ENVIRONMENT_LABEL[stored.environment].toLowerCase()} credentials stored — not in use until you activate them.`);
    } catch (failure) {
      setError(message(failure, "The credentials could not be stored. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate aria-label={`${PROVIDER_LABEL[provider]} ${ENVIRONMENT_LABEL[environment]} credentials`} onSubmit={(e) => void submit(e)} className="space-y-3 rounded-md border p-3">
      <p className="text-sm">
        Enter the {environment === "SANDBOX" ? "sandbox (test)" : "live production"} credentials from your {provider === "MPESA" ? "Safaricom Daraja" : "KRA eTIMS"} account. <strong>Secret fields are encrypted and never shown again — not even to you.</strong>
      </p>
      {replacing ? (
        <p className="rounded-md border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-sm">
          These replace the stored ones and go back to “not active” until you activate them again{replacing.status === "ACTIVE" ? ", so this environment stops working until then" : ""}.
          {provider === "ETIMS" ? " New eTIMS credentials also need the device initialized again (KRA eTIMS & tax → Device)." : ""}
        </p>
      ) : null}
      {fields.map((f) => (
        <TextField
          key={f.name}
          id={`${prefix}-${f.name}`}
          label={f.label}
          optional={!f.required}
          type={f.secret ? "password" : "text"}
          autoComplete={f.secret ? "new-password" : "off"}
          spellCheck={false}
          value={values[f.name] ?? ""}
          error={problems[f.name]}
          hint={f.hint}
          onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
        />
      ))}
      <TextField id={`${prefix}-label`} label="Note for yourself" optional autoComplete="off" hint="Not secret, e.g. “Till 174379”." value={label} onChange={(e) => setLabel(e.target.value)} />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" className="h-11" disabled={saving}>
          {saving ? "Storing…" : "Store securely"}
        </Button>
      </div>
    </form>
  );
}

function EnvironmentBlock({ summary, environment, onNotice }: { summary: ProviderSummary; environment: Environment; onNotice: (note: string) => void }) {
  const invalidate = useInvalidateSettings();
  const credential = summary.credentials.find((c) => c.environment === environment) ?? null;
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inUse = summary.settings.activeEnvironment === environment;

  async function activate() {
    setSaving(true);
    setError(null);
    try {
      await activateCredential(summary.provider, environment);
      await invalidate();
      onNotice(`${PROVIDER_LABEL[summary.provider]} ${ENVIRONMENT_LABEL[environment].toLowerCase()} credentials are active.`);
    } catch (failure) {
      setError(message(failure, "The credentials could not be activated. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">
          {ENVIRONMENT_LABEL[environment]}
          {inUse ? <span className="font-normal text-muted-foreground"> · in use</span> : null}
        </h3>
        {credential ? <StatusBadge status={credential.status} /> : <span className="text-xs text-muted-foreground">Nothing stored</span>}
      </div>
      {credential ? (
        <p className="text-xs text-muted-foreground">
          {credential.label ? `${credential.label} · ` : ""}Stored {formatDateTime(credential.updatedAt)} · encrypted with key {credential.keyRef}
          {credential.lastVerifiedAt ? ` · verified ${formatDateTime(credential.lastVerifiedAt)}` : ""}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {writing ? (
        <CredentialForm
          provider={summary.provider}
          environment={environment}
          replacing={credential}
          onClose={() => setWriting(false)}
          onStored={(note) => {
            setWriting(false);
            onNotice(note);
          }}
        />
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="h-11" onClick={() => setWriting(true)} aria-label={`${credential ? "Replace" : "Store"} ${PROVIDER_LABEL[summary.provider]} ${ENVIRONMENT_LABEL[environment]} credentials`}>
            {credential ? "Replace credentials" : "Store credentials"}
          </Button>
          {credential && credential.status !== "ACTIVE" ? (
            <Button type="button" className="h-11" onClick={() => void activate()} disabled={saving} aria-label={`Activate ${PROVIDER_LABEL[summary.provider]} ${ENVIRONMENT_LABEL[environment]} credentials`}>
              {saving ? "Activating…" : "Activate"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function GoLive({ summary, onNotice }: { summary: ProviderSummary; onNotice: (note: string) => void }) {
  const confirmId = useId();
  const invalidate = useInvalidateSettings();
  const [asking, setAsking] = useState<"PRODUCTION" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { provider, settings } = summary;
  const name = PROVIDER_LABEL[provider];

  async function change(body: { activeEnvironment?: Environment; enabled?: boolean }, note: string) {
    setSaving(true);
    setError(null);
    try {
      await saveIntegrationSetting(provider, body);
      await invalidate();
      setAsking(null);
      onNotice(note);
    } catch (failure) {
      setError(message(failure, "The setting could not be changed. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <p>
        {name} is <strong>{settings.enabled ? "on" : "off"}</strong>, using <strong>{ENVIRONMENT_LABEL[settings.activeEnvironment].toLowerCase()}</strong>.
      </p>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {asking ? (
        <div role="alertdialog" aria-labelledby={confirmId} className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <p id={confirmId} className="font-medium">
            Switch {name} to production?
          </p>
          <p>
            {provider === "MPESA"
              ? "From now on payment prompts go to customers’ real phones and real money settles to the shortcode in your production credentials."
              : provider === "ETIMS"
                ? "From now on invoices are filed with KRA for real, under your KRA PIN. A filed invoice can only be reversed by a credit note."
                : "From now on it uses your live account."}{" "}
            Make sure the production credentials are right and active first.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(null)} disabled={saving} data-autofocus>
              Back
            </Button>
            <Button type="button" variant="destructive" className="h-11" onClick={() => void change({ activeEnvironment: "PRODUCTION" }, `${name} is now using production.`)} disabled={saving}>
              {saving ? "Switching…" : "Yes, go live"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="h-11" disabled={saving} onClick={() => void change({ enabled: !settings.enabled }, `${name} is switched ${settings.enabled ? "off" : "on"}.`)}>
            {settings.enabled ? `Switch ${name} off` : `Switch ${name} on`}
          </Button>
          {settings.activeEnvironment === "SANDBOX" ? (
            <Button type="button" variant="outline" className="h-11" disabled={saving} onClick={() => setAsking("PRODUCTION")}>
              Use production (go live)
            </Button>
          ) : (
            <Button type="button" variant="outline" className="h-11" disabled={saving} onClick={() => void change({ activeEnvironment: "SANDBOX" }, `${name} is back on the sandbox.`)}>
              Go back to sandbox
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ProviderCard({ summary }: { summary: ProviderSummary }) {
  const heading = useId();
  const [notice, setNotice] = useState<string | null>(null);
  const supported = summary.credentialsSupported && CREDENTIAL_FIELDS[summary.provider] !== undefined;
  return (
    <section aria-labelledby={heading} className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 id={heading} className="font-medium">
          {PROVIDER_LABEL[summary.provider]}
        </h2>
        <p className="text-sm text-muted-foreground">{PROVIDER_PURPOSE[summary.provider]}</p>
      </div>
      {!supported ? (
        <p className="text-sm text-muted-foreground">Not available yet — credentials for this provider can’t be stored in this version.</p>
      ) : (
        <>
          {notice ? <Done>{notice}</Done> : null}
          <GoLive summary={summary} onNotice={setNotice} />
          <div className="grid gap-3 md:grid-cols-2">
            {ENVIRONMENTS.map((environment) => (
              <EnvironmentBlock key={environment} summary={summary} environment={environment} onNotice={setNotice} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function IntegrationsView() {
  const integrations = useIntegrations(true);
  if (integrations.isPending) return <LoadingState label="Loading the integrations" lines={4} />;
  if (integrations.isError) return <ErrorState title="Couldn’t load the integrations" description={integrations.error.message} onRetry={() => void integrations.refetch()} />;
  const order: readonly Provider[] = ["MPESA", "ETIMS", "STRIPE", "SMS"];
  const data = [...integrations.data.data].sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Your business’s own accounts with each provider. Each runs on its own credentials, under your own shortcode and KRA PIN — there is no shared account to fall back to. To go live: store the production credentials, activate them, then switch to production.
      </p>
      {data.map((summary) => (
        <ProviderCard key={summary.provider} summary={summary} />
      ))}
    </div>
  );
}
