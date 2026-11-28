"use client";

import { useId, useState, type ReactNode } from "react";
import { TextField } from "@/components/auth/form-bits";
import { SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { CANDIDATE_FIELD_LABEL, inviteMentor, REGIME_LABEL, REGIMES, useDirectory, useInvalidateAdmin, type Candidate, type CandidateError } from "@/lib/admin/admin";
import { Greeting } from "@/components/shell/greeting";

// Pieces the platform-administration screens share: the business-and-owner form every onboarding
// path takes (with the green-gate's field errors placed on their fields), a confirmation, and
// inviting a mentor to a business.

export const message = (failure: unknown, fallback: string) => (failure instanceof ApiHttpError ? failure.message : fallback);

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

export function Page({ title, intro, children, action }: { title: string; intro: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <Greeting />
          <h1 className="font-display text-2xl font-semibold">{title}</h1>
          <p className="text-sm text-muted-foreground">{intro}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

/** GREEN / RED, as the green-gate reports it. */
export function GateBadge({ status }: { status: "GREEN" | "RED" }) {
  return (
    <span className={status === "GREEN" ? "rounded-full border border-emerald-700/40 bg-emerald-700/10 px-2 py-0.5 text-xs font-medium" : "rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium"}>
      {status === "GREEN" ? "Green — ready" : "Red — needs fixing"}
    </span>
  );
}

export function GateErrors({ errors }: { errors: readonly CandidateError[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-sm text-destructive">
      {errors.map((e) => (
        <li key={`${e.field}-${e.code}`}>
          {CANDIDATE_FIELD_LABEL[e.field] ?? e.field}: {e.message}
        </li>
      ))}
    </ul>
  );
}

export interface CandidateDraft {
  businessName: string;
  subdomain: string;
  sector: string;
  kraPin: string;
  taxRegime: string;
  ownerFullName: string;
  ownerEmail: string;
  ownerPhone: string;
  ownerNationalId: string;
}

export const blankCandidate = (): CandidateDraft => ({ businessName: "", subdomain: "", sector: "", kraPin: "", taxRegime: "TURNOVER_TAX", ownerFullName: "", ownerEmail: "", ownerPhone: "", ownerNationalId: "" });

export const candidateOf = (d: CandidateDraft): Candidate => {
  const opt = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    businessName: d.businessName.trim(),
    subdomain: opt(d.subdomain),
    sector: opt(d.sector),
    kraPin: d.kraPin.trim() === "" ? null : d.kraPin.trim().toUpperCase(),
    taxRegime: d.taxRegime,
    ownerFullName: d.ownerFullName.trim(),
    ownerEmail: d.ownerEmail.trim(),
    ownerPhone: opt(d.ownerPhone),
    ownerNationalId: opt(d.ownerNationalId),
  };
};

/** The business-and-owner fields; the green-gate's errors land on the field they name. */
export function CandidateFields({ draft, onChange, errors }: { draft: CandidateDraft; onChange: (draft: CandidateDraft) => void; errors: readonly CandidateError[] }) {
  const prefix = useId();
  const errorOf = (field: string) => errors.find((e) => e.field === field)?.message;
  const text = (field: Exclude<keyof CandidateDraft, "taxRegime">, opts: { optional?: boolean; type?: string; hint?: string } = {}) => (
    <TextField
      id={`${prefix}-${field}`}
      label={CANDIDATE_FIELD_LABEL[field] ?? field}
      optional={opts.optional}
      type={opts.type ?? "text"}
      autoComplete="off"
      hint={opts.hint}
      value={draft[field]}
      error={errorOf(field)}
      onChange={(e) => onChange({ ...draft, [field]: e.target.value })}
    />
  );
  return (
    <div className="space-y-4">
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-medium">The business</legend>
        {text("businessName")}
        {text("subdomain", { optional: true, hint: "Left empty, one is made from the name." })}
        {text("sector", { optional: true })}
        {text("kraPin", { optional: true })}
        <div className="space-y-1">
          <SelectField id={`${prefix}-regime`} label="Tax regime" value={draft.taxRegime} onChange={(v) => onChange({ ...draft, taxRegime: v })}>
            {REGIMES.map((r) => (
              <option key={r} value={r}>
                {REGIME_LABEL[r]}
              </option>
            ))}
          </SelectField>
          {errorOf("taxRegime") ? <p className="text-sm text-destructive">{errorOf("taxRegime")}</p> : null}
        </div>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-medium">The owner</legend>
        {text("ownerFullName")}
        {text("ownerEmail", { type: "email" })}
        {text("ownerPhone", { optional: true, type: "tel" })}
        {text("ownerNationalId", { optional: true })}
      </fieldset>
    </div>
  );
}

/** A confirmation with its consequence spelled out. */
export function Confirm({ title, children, yes, busy, destructive = false, onBack, onYes }: { title: string; children: ReactNode; yes: string; busy: boolean; destructive?: boolean; onBack: () => void; onYes: () => void }) {
  const heading = useId();
  return (
    <div role="alertdialog" aria-labelledby={heading} className="space-y-2 rounded-md border p-3 text-sm">
      <p id={heading} className="font-medium">
        {title}
      </p>
      {children}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={onBack} disabled={busy} data-autofocus>
          Back
        </Button>
        <Button type="button" variant={destructive ? "destructive" : "default"} className="h-11" onClick={onYes} disabled={busy}>
          {busy ? "Working…" : yes}
        </Button>
      </div>
    </div>
  );
}

/**
 * Invite a mentor or coach to a business, chosen from the platform user directory
 * (GET /v1/users/directory, T-B-ADMIN-USER-LIST) — every active mentor and coach.
 */
export function InviteMentor({ tenantId, businessName }: { tenantId: string; businessName: string }) {
  const ids = { mentor: useId() };
  const invalidate = useInvalidateAdmin();
  const [open, setOpen] = useState(false);
  const mentors = useDirectory({ role: "MENTOR", take: 200 }, open);
  const coaches = useDirectory({ role: "COACH", take: 200 }, open);
  const [mentor, setMentor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const people = [...(mentors.data?.data ?? []), ...(coaches.data?.data ?? [])].filter((u) => u.isActive).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const loading = open && (mentors.isPending || coaches.isPending);
  const mentorId = mentor;
  async function invite() {
    if (mentorId === "") {
      setError("Choose the mentor or coach to invite.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const engagement = await inviteMentor(mentorId, tenantId);
      await invalidate();
      setOpen(false);
      setNotice(`${engagement.mentorName} is invited to ${engagement.businessName}. Nothing is shared until its owner consents.`);
    } catch (failure) {
      setError(message(failure, "The mentor could not be invited. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-2">
      {notice ? (
        <p role="status" className="rounded-md border border-emerald-700/40 bg-emerald-700/10 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      {open ? (
        <section aria-label={`Invite a mentor to ${businessName}`} className="space-y-3 rounded-md border p-3">
          <p className="text-sm">The owner of {businessName} is asked to consent. Until they do, the mentor sees nothing of the business.</p>
          <SelectField id={ids.mentor} label="Mentor" value={mentor} onChange={setMentor} disabled={loading} hint={loading ? "Loading mentors and coaches…" : people.length === 0 ? "No active mentor or coach yet — invite one from Users first." : undefined}>
            <option value="">Choose a mentor or coach…</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName} ({u.role === "COACH" ? "coach" : "mentor"}) · {u.email}
              </option>
            ))}
          </SelectField>
          {error ? <ErrorLine>{error}</ErrorLine> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="h-11" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" className="h-11" onClick={() => void invite()} disabled={saving}>
              {saving ? "Inviting…" : "Send the invitation"}
            </Button>
          </div>
        </section>
      ) : (
        <Button type="button" variant="outline" className="h-11" onClick={() => setOpen(true)}>
          Invite a mentor
        </Button>
      )}
    </div>
  );
}
