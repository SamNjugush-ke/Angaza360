"use client";

import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { useId, useMemo, useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { formatDateTime } from "@/lib/datetime";
import {
  onboard,
  REGIME_LABEL,
  TENANT_STATUS_LABEL,
  tenantLifecycle,
  useInvalidateAdmin,
  useTenants,
  validateCandidate,
  type AdminPermissions,
  type CandidateError,
  type Tenant,
  type TenantStatus,
  type ValidationReport,
} from "@/lib/admin/admin";
import { cn } from "@/lib/utils";
import { blankCandidate, candidateOf, CandidateFields, Confirm, ErrorLine, GateBadge, GateErrors, InviteMentor, message, Page, type CandidateDraft } from "./shared";

// THE TENANT REGISTRY. Onboarding a business directly: check it against the green-gate first (it
// writes nothing), then — SUPER_ADMIN only — set it up and invite its owner. The lifecycle:
// suspending LOCKS EVERY USER OF THE BUSINESS OUT at once; reactivating lets them back in;
// deactivating is final. Each is confirmed with its consequence spelled out.
//
// THE EXPLORER (M4.5 W5): the businesses report's filters — status (the server's), and plan, county,
// sector and name over the registry rows on screen — with each business opening its full detail
// page (/admin/tenants/{id}: health, users, lifecycle, support access).

const TIERS = ["MWANZO", "UKUAJI", "BIASHARA", "MSTAWI", "ENTERPRISE"] as const;
type Tier = (typeof TIERS)[number];

export interface TenantFilters {
  q: string;
  tier: Tier | "";
  county: string;
  sector: string;
}

/** The explorer's filters over registry rows: plan exact, county exact, sector and name contain (case-insensitive). */
export function filterTenants(rows: readonly Tenant[], f: TenantFilters): Tenant[] {
  const q = f.q.trim().toLowerCase();
  const sector = f.sector.trim().toLowerCase();
  return rows.filter(
    (t) =>
      (f.tier === "" || t.subscriptionTier === f.tier) &&
      (f.county === "" || (t.county ?? "").toLowerCase() === f.county.toLowerCase()) &&
      (sector === "" || (t.businessSector ?? "").toLowerCase().includes(sector)) &&
      (q === "" || t.name.toLowerCase().includes(q) || t.subdomain.toLowerCase().includes(q)),
  );
}

export function TenantBadge({ status }: { status: TenantStatus }) {
  return (
    <span className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-medium", status === "ACTIVE" ? "border-emerald-700/40 bg-emerald-700/10" : status === "SUSPENDED" ? "border-amber-600/40 bg-amber-500/10" : status === "DEACTIVATED" ? "border-destructive/40 bg-destructive/10" : "")}>
      {TENANT_STATUS_LABEL[status]}
    </span>
  );
}

type Action = "suspend" | "reactivate" | "deactivate";
const ACTION_WORDS: Readonly<Record<Action, { button: string; ask: (name: string) => string; detail: string; yes: string }>> = {
  suspend: { button: "Suspend", ask: (n) => `Suspend ${n}?`, detail: "Every user of the business is locked out at once — they cannot sign in or use the till until it is reactivated. Nothing is deleted.", yes: "Yes, suspend" },
  reactivate: { button: "Reactivate", ask: (n) => `Reactivate ${n}?`, detail: "Its users can sign in again.", yes: "Yes, reactivate" },
  deactivate: { button: "Deactivate", ask: (n) => `Deactivate ${n} for good?`, detail: "This is final: the business can never be reactivated and its users are locked out permanently. Its records are kept.", yes: "Yes, deactivate permanently" },
};

/**
 * The lifecycle controls — suspend, reactivate, deactivate — each CONFIRMED with its consequence.
 * Deactivation is TERMINAL; on the business detail page (`confirmName`) it also asks for the
 * business's name to be typed before the button arms.
 */
export function LifecycleActions({ tenant, onDone, confirmName = false }: { tenant: Tenant; onDone: (note: string) => void; confirmName?: boolean }) {
  const reasonId = useId();
  const nameId = useId();
  const terminalId = useId();
  const invalidate = useInvalidateAdmin();
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const allowed: Action[] = tenant.status === "ACTIVE" ? ["suspend", "deactivate"] : tenant.status === "SUSPENDED" ? ["reactivate", "deactivate"] : [];
  const nameOk = !(confirmName && action === "deactivate") || typed.trim() === tenant.name;
  async function confirm() {
    if (!action || !nameOk) return;
    setSaving(true);
    setError(null);
    try {
      const next = await tenantLifecycle(tenant.id, action, reason.trim() || undefined);
      await invalidate();
      setAction(null);
      setReason("");
      setTyped("");
      onDone(`${next.name} is now ${TENANT_STATUS_LABEL[next.status].toLowerCase()}.`);
    } catch (failure) {
      setAction(null);
      setError(message(failure, "That could not be done. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-3">
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {action ? (
        <Confirm title={ACTION_WORDS[action].ask(tenant.name)} yes={ACTION_WORDS[action].yes} busy={saving || !nameOk} destructive={action !== "reactivate"} onBack={() => { setAction(null); setTyped(""); }} onYes={() => void confirm()}>
          <p>{ACTION_WORDS[action].detail}</p>
          {confirmName && action === "deactivate" ? (
            <TextField id={nameId} label={`Type the business’s name — ${tenant.name} — to confirm`} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          ) : null}
          <TextField id={reasonId} label="Reason" optional autoComplete="off" hint="Recorded in the audit log." value={reason} onChange={(e) => setReason(e.target.value)} />
        </Confirm>
      ) : allowed.length > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {allowed.map((a) => (
            <Button key={a} type="button" variant={confirmName && a === "deactivate" ? "destructive" : "outline"} className="h-11" onClick={() => setAction(a)} aria-describedby={confirmName && a === "deactivate" ? terminalId : undefined}>
              {ACTION_WORDS[a].button}
            </Button>
          ))}
          {confirmName && allowed.includes("deactivate") ? (
            <p id={terminalId} className="text-xs text-destructive">
              Deactivating is final: the business can never be reactivated.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{tenant.status === "DEACTIVATED" ? "Deactivated for good." : "It is still being set up."}</p>
      )}
    </div>
  );
}

function TenantDetail({ tenant, onDone }: { tenant: Tenant; onDone: (note: string) => void }) {
  const facts: Array<[string, string | null]> = [
    ["Status", TENANT_STATUS_LABEL[tenant.status]],
    ["Subdomain", tenant.subdomain],
    ["Sector", tenant.businessSector],
    ["County", tenant.county],
    ["KRA PIN", tenant.kraPin],
    ["Tax regime", REGIME_LABEL[tenant.taxRegime] ?? tenant.taxRegime],
    ["Plan", `${tenant.subscriptionTier} · ${tenant.subscriptionStatus.toLowerCase().replace("_", " ")}`],
    ["Joined", formatDateTime(tenant.createdAt)],
    ["Business id", tenant.id],
  ];
  return (
    <div className="space-y-4">
      <dl className="text-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className={v ? "break-all text-right" : "text-right text-muted-foreground"}>{v ?? "Not recorded"}</dd>
          </div>
        ))}
      </dl>
      <LifecycleActions tenant={tenant} onDone={onDone} />
      {tenant.status === "ACTIVE" ? <InviteMentor tenantId={tenant.id} businessName={tenant.name} /> : null}
      <Link href={`/admin/tenants/${encodeURIComponent(tenant.id)}`} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
        Open the business — health, users and support access
      </Link>
    </div>
  );
}

function OnboardForm({ permissions, onDone, onCancel }: { permissions: AdminPermissions; onDone: (note: string) => void; onCancel: () => void }) {
  const invalidate = useInvalidateAdmin();
  const [draft, setDraft] = useState<CandidateDraft>(blankCandidate);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const edit = (next: CandidateDraft) => {
    setDraft(next);
    setReport(null);
  };
  async function check(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      setReport(await validateCandidate(candidateOf(draft)));
    } catch (failure) {
      setError(message(failure, "The details could not be checked. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  async function go() {
    setSaving(true);
    setError(null);
    try {
      const done = await onboard(candidateOf(draft));
      await invalidate();
      onDone(`${done.tenant.name} is live at ${done.tenant.subdomain}. Its owner (${done.ownerInvitation.invitation.email}) has been invited — the code goes by email${done.ownerInvitation.delivery.sms ? " and SMS" : ""}.`);
    } catch (failure) {
      setReport(null);
      setError(message(failure, "The business could not be set up. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  const errors: readonly CandidateError[] = report?.errors ?? [];
  return (
    <form noValidate aria-label="Onboard a business" onSubmit={(e) => void check(e)} className="space-y-4">
      <p className="text-sm text-muted-foreground">Check the details against the green-gate first — it writes nothing. A green business can then be set up and its owner invited.</p>
      <CandidateFields draft={draft} onChange={edit} errors={errors} />
      {report ? (
        <section aria-label="Green-gate report" className="space-y-2 rounded-md border p-3" aria-live="polite">
          <GateBadge status={report.status} />
          <GateErrors errors={report.errors} />
          {report.status === "GREEN" && report.proposedSubdomain ? <p className="text-sm">It will be set up at {report.proposedSubdomain}.</p> : null}
        </section>
      ) : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant={report?.status === "GREEN" ? "outline" : "default"} className="h-11" disabled={saving}>
          {saving && !report ? "Checking…" : "Check the details"}
        </Button>
        {report?.status === "GREEN" && permissions.isSuperAdmin ? (
          <Button type="button" className="h-11" onClick={() => void go()} disabled={saving}>
            {saving ? "Setting up…" : "Set up the business and invite the owner"}
          </Button>
        ) : null}
      </div>
      {report?.status === "GREEN" && !permissions.isSuperAdmin ? <p className="text-sm text-muted-foreground">It is ready. A super-administrator sets it up.</p> : null}
    </form>
  );
}

/** The businesses report in the reporting center, with these same filters applied. */
export function reportLink(status: TenantStatus | "", f: TenantFilters): string {
  const params = new URLSearchParams({ report: "businesses" });
  for (const [key, value] of [["status", status], ["tier", f.tier], ["county", f.county], ["sector", f.sector.trim()], ["q", f.q.trim()]] as const) if (value) params.set(key, value);
  return `/admin/reports?${params.toString()}`;
}

export function Tenants({ permissions, initialStatus = "" }: { permissions: AdminPermissions; initialStatus?: TenantStatus | "" }) {
  const statusId = useId();
  const ids = { q: useId(), tier: useId(), county: useId(), sector: useId() };
  const [status, setStatus] = useState<TenantStatus | "">(initialStatus);
  const [filters, setFilters] = useState<TenantFilters>({ q: "", tier: "", county: "", sector: "" });
  const tenants = useTenants(status);
  const all = useMemo(() => tenants.data?.data ?? [], [tenants.data]);
  const shown = useMemo(() => filterTenants(all, filters), [all, filters]);
  const counties = useMemo(() => [...new Set(all.map((t) => t.county).filter((c): c is string => c !== null))].sort(), [all]);
  const set = (patch: Partial<TenantFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const [openId, setOpenId] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const open = tenants.data?.data.find((t) => t.id === openId) ?? null;
  return (
    <Page
      title="Tenants"
      intro="Every business on the platform and its state."
      action={
        <Button type="button" className="h-11" onClick={() => setOnboarding(true)}>
          <Plus className="size-4" aria-hidden /> Onboard a business
        </Button>
      }
    >
      {notice ? <Done>{notice}</Done> : null}
      <div role="search" aria-label="Filter businesses" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1.5 lg:col-span-2">
          <label htmlFor={ids.q} className="text-sm font-medium">
            Name or subdomain
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input id={ids.q} type="search" value={filters.q} onChange={(e) => set({ q: e.target.value })} className="h-11 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm" />
          </div>
        </div>
        <SelectField id={statusId} label="Status" value={status} onChange={(v) => setStatus(v as TenantStatus | "")}>
          <option value="">Every business</option>
          {(Object.keys(TENANT_STATUS_LABEL) as TenantStatus[]).map((s) => (
            <option key={s} value={s}>
              {TENANT_STATUS_LABEL[s]}
            </option>
          ))}
        </SelectField>
        <SelectField id={ids.tier} label="Plan" value={filters.tier} onChange={(v) => set({ tier: v as Tier | "" })}>
          <option value="">Every plan</option>
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0) + t.slice(1).toLowerCase()}
            </option>
          ))}
        </SelectField>
        <SelectField id={ids.county} label="County" value={filters.county} onChange={(v) => set({ county: v })}>
          <option value="">Every county</option>
          {counties.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </SelectField>
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
          <label htmlFor={ids.sector} className="text-sm font-medium">
            Sector contains
          </label>
          <input id={ids.sector} type="search" value={filters.sector} onChange={(e) => set({ sector: e.target.value })} className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" />
        </div>
      </div>
      {tenants.isSuccess ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Showing <span className="font-mono tabular-nums text-foreground">{shown.length.toString()}</span> of <span className="font-mono tabular-nums">{all.length.toString()}</span>
          </p>
          <Link href={reportLink(status, filters)} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
            Export this view
          </Link>
        </div>
      ) : null}
      {tenants.isPending ? <LoadingState label="Loading businesses" lines={4} /> : null}
      {tenants.isError ? <ErrorState title="Couldn’t load the businesses" description={tenants.error.message} onRetry={() => void tenants.refetch()} /> : null}
      {tenants.isSuccess && shown.length === 0 ? <EmptyState title="No businesses match" description="Try another status, plan, county or name." /> : null}
      {tenants.isSuccess && shown.length > 0 ? (
        <ul aria-label="Businesses" className="space-y-2">
          {shown.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setOpenId(t.id)}
                className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>
                  <span className="font-medium">{t.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t.subdomain} · {REGIME_LABEL[t.taxRegime] ?? t.taxRegime} · {t.subscriptionTier}
                    {t.county ? ` · ${t.county}` : ""}
                  </span>
                </span>
                <TenantBadge status={t.status} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <Sheet key={open.id} title={open.name} onClose={() => setOpenId(null)} wide>
          <TenantDetail
            tenant={open}
            onDone={(note) => {
              setOpenId(null);
              setNotice(note);
            }}
          />
        </Sheet>
      ) : null}
      {onboarding ? (
        <Sheet title="Onboard a business" onClose={() => setOnboarding(false)} wide>
          <OnboardForm
            permissions={permissions}
            onCancel={() => setOnboarding(false)}
            onDone={(note) => {
              setOnboarding(false);
              setNotice(note);
            }}
          />
        </Sheet>
      ) : null}
    </Page>
  );
}
