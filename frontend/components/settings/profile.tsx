"use client";

import { useId, useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/form-bits";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { EMAIL, KRA_PIN, REGIME_LABEL, REGIME_MEANING, saveProfile, useInvalidateSettings, useProfile, type Profile, type ProfileUpdate, type TaxRegime } from "@/lib/settings/settings";
import { Facts, ReadOnlyNote } from "./shared";

// The business profile: the TAX REGIME (authoritative for posting — it decides whether a sale
// charges VAT or accrues Turnover Tax, how purchases are costed, and which return KRA eTIMS & tax
// shows), the business's own KRA PIN and the identity every receipt prints. The owner sets it;
// everyone else who may read it sees it as facts. Changing the regime is not retroactive.

const REGIMES: readonly TaxRegime[] = ["VAT_REGISTERED", "TURNOVER_TAX", "EXEMPT"];

interface Draft {
  taxRegime: TaxRegime;
  kraPin: string;
  legalName: string;
  addressLine: string;
  phone: string;
  email: string;
  receiptFooter: string;
  showLogoOnReceipt: boolean;
}
type Problems = Partial<Record<keyof Draft, string>>;

const draftOf = (p: Profile): Draft => ({
  taxRegime: p.taxRegime,
  kraPin: p.kraPin ?? "",
  legalName: p.legalName ?? "",
  addressLine: p.addressLine ?? "",
  phone: p.phone ?? "",
  email: p.email ?? "",
  receiptFooter: p.receiptFooter ?? "",
  showLogoOnReceipt: p.showLogoOnReceipt,
});

function check(d: Draft): Problems {
  const problems: Problems = {};
  const pin = d.kraPin.trim().toUpperCase();
  if (pin !== "" && !KRA_PIN.test(pin)) problems.kraPin = "A KRA PIN is a letter, nine digits and a letter, e.g. P051234567X.";
  if (d.legalName.trim().length > 200) problems.legalName = "Keep the legal name to 200 characters.";
  if (d.addressLine.trim().length > 300) problems.addressLine = "Keep the address to 300 characters.";
  if (d.phone.trim().length > 30) problems.phone = "Keep the phone number to 30 characters.";
  if (d.email.trim() !== "" && !EMAIL.test(d.email.trim())) problems.email = "Enter an email address, e.g. info@business.co.ke, or leave it empty.";
  if (d.receiptFooter.trim().length > 500) problems.receiptFooter = "Keep the footer to 500 characters.";
  return problems;
}

const orNull = (value: string) => (value.trim() === "" ? null : value.trim());
const bodyOf = (d: Draft): ProfileUpdate => ({
  taxRegime: d.taxRegime,
  kraPin: d.kraPin.trim() === "" ? null : d.kraPin.trim().toUpperCase(),
  legalName: orNull(d.legalName),
  addressLine: orNull(d.addressLine),
  phone: orNull(d.phone),
  email: orNull(d.email),
  receiptFooter: orNull(d.receiptFooter),
  showLogoOnReceipt: d.showLogoOnReceipt,
});

function ProfileForm({ profile }: { profile: Profile }) {
  const ids = { regime: useId(), pin: useId(), legal: useId(), address: useId(), phone: useId(), email: useId(), footer: useId(), logo: useId(), confirm: useId() };
  const invalidate = useInvalidateSettings();
  const [draft, setDraft] = useState<Draft>(() => draftOf(profile));
  const [problems, setProblems] = useState<Problems>({});
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const regimeChanges = draft.taxRegime !== profile.taxRegime;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveProfile(bodyOf(draft));
      await invalidate();
      setAsking(false);
      setDraft(draftOf(saved));
      setNotice(
        saved.taxRegime !== profile.taxRegime
          ? `Saved. The business is now ${REGIME_LABEL[saved.taxRegime]} — from now on. ${REGIME_MEANING[saved.taxRegime]}`
          : "Saved. Receipts print the new details from the next sale.",
      );
    } catch (failure) {
      // Keep everything typed; the server's words say what to change.
      setError(failure instanceof ApiHttpError ? failure.message : "The profile could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const found = check(draft);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    if (regimeChanges) setAsking(true);
    else void save();
  }

  return (
    <form noValidate aria-label="Business profile" onSubmit={submit} className="max-w-2xl space-y-6">
      {notice ? <Done>{notice}</Done> : null}
      <fieldset className="space-y-3">
        <legend className="font-medium">Tax</legend>
        <SelectField id={ids.regime} label="Tax regime" value={draft.taxRegime} onChange={(v) => set("taxRegime", v as TaxRegime)} hint={REGIME_MEANING[draft.taxRegime]}>
          {REGIMES.map((r) => (
            <option key={r} value={r}>
              {REGIME_LABEL[r]}
            </option>
          ))}
        </SelectField>
        <TextField id={ids.pin} label="KRA PIN" optional autoComplete="off" value={draft.kraPin} error={problems.kraPin} hint="The business’s own PIN, printed on receipts." onChange={(e) => set("kraPin", e.target.value)} />
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="font-medium">What receipts print</legend>
        <TextField id={ids.legal} label="Registered (legal) name" optional autoComplete="organization" value={draft.legalName} error={problems.legalName} onChange={(e) => set("legalName", e.target.value)} />
        <TextField id={ids.address} label="Address" optional autoComplete="street-address" value={draft.addressLine} error={problems.addressLine} onChange={(e) => set("addressLine", e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id={ids.phone} label="Phone" optional type="tel" autoComplete="tel" value={draft.phone} error={problems.phone} onChange={(e) => set("phone", e.target.value)} />
          <TextField id={ids.email} label="Email" optional type="email" autoComplete="email" value={draft.email} error={problems.email} onChange={(e) => set("email", e.target.value)} />
        </div>
        <TextField id={ids.footer} label="Receipt footer" optional autoComplete="off" value={draft.receiptFooter} error={problems.receiptFooter} hint="E.g. “Goods once sold are not returnable.”" onChange={(e) => set("receiptFooter", e.target.value)} />
        <div className="flex min-h-11 items-center gap-2">
          <input id={ids.logo} type="checkbox" className="size-5" checked={draft.showLogoOnReceipt} onChange={(e) => set("showLogoOnReceipt", e.target.checked)} />
          <label htmlFor={ids.logo} className="text-sm">
            Print the logo on receipts (set the logo on the Branding tab)
          </label>
        </div>
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {asking ? (
        <div role="alertdialog" aria-labelledby={ids.confirm} className="space-y-2 rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-sm">
          <p id={ids.confirm} className="font-medium">
            Change the tax regime from {REGIME_LABEL[profile.taxRegime]} to {REGIME_LABEL[draft.taxRegime]}?
          </p>
          <p>{REGIME_MEANING[draft.taxRegime]}</p>
          <p>It applies to sales and purchases from now on. Nothing already posted changes; a past mistake is corrected with an adjusting entry.</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving} data-autofocus>
              Back
            </Button>
            <Button type="button" className="h-11" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Yes, change the regime"}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" className="h-11" disabled={saving}>
          {saving ? "Saving…" : "Save the profile"}
        </Button>
      )}
    </form>
  );
}

export function ProfileView({ owner }: { owner: boolean }) {
  const profile = useProfile();
  if (profile.isPending) return <LoadingState label="Loading the business profile" lines={5} />;
  if (profile.isError) return <ErrorState title="Couldn’t load the business profile" description={profile.error.message} onRetry={() => void profile.refetch()} />;
  const p = profile.data;
  if (owner) return <ProfileForm profile={p} />;
  return (
    <div className="space-y-4">
      <ReadOnlyNote />
      <Facts
        label="Business profile details"
        facts={[
          ["Tax regime", `${REGIME_LABEL[p.taxRegime]} — ${REGIME_MEANING[p.taxRegime]}`],
          ["KRA PIN", p.kraPin],
          ["Registered name", p.legalName],
          ["Address", p.addressLine],
          ["Phone", p.phone],
          ["Email", p.email],
          ["Receipt footer", p.receiptFooter],
          ["Logo on receipts", p.showLogoOnReceipt ? "Printed" : "Not printed"],
        ]}
      />
    </div>
  );
}
