"use client";

import { Plus, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, shillingsProblem } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, formatDate, toBusinessDate } from "@/lib/datetime";
import { centsToAmount, formatKES, parseMajorToCents } from "@/lib/money";
import { RATE, supersedeSchedule, useCurrentSchedule, useInvalidateSettings, useSchedules, type Schedule, type SupersedeBody } from "@/lib/settings/settings";
import { Facts } from "./shared";

// Statutory schedules: the effective-dated ruleset behind every payroll deduction, the standard VAT
// rate and the Turnover Tax rate. A version is never edited — a change of law is a NEW version from
// a FUTURE commencement date, and the version in force closes the day before (supersede-forward).
// The owner supersedes; the manager and accountant read. The server refuses a date that would
// change which rates governed anything already posted, in its own words.

const DAY = 86_400_000;
/** The last day a version governs: its window is [effectiveFrom, effectiveTo). */
const lastDayOf = (effectiveTo: string) => toBusinessDate(new Date(Date.parse(effectiveTo) - DAY));
const windowOf = (s: Schedule) => `${formatDate(s.effectiveFrom)} – ${s.effectiveTo === null ? "until superseded" : formatDate(lastDayOf(s.effectiveTo))}`;
const shillings = (cents: string) => `KES ${formatKES(cents)}`;
const percent = (rate: string) => `${rate}%`;

function Bands({ schedule }: { schedule: Schedule }) {
  return (
    <table className="w-full max-w-2xl text-sm">
      <caption className="pb-1 text-left font-medium">PAYE bands (monthly taxable pay)</caption>
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th scope="col" className="py-1 font-normal">
            From
          </th>
          <th scope="col" className="py-1 font-normal">
            Up to
          </th>
          <th scope="col" className="py-1 text-right font-normal">
            Rate
          </th>
        </tr>
      </thead>
      <tbody>
        {schedule.bands.map((band) => (
          <tr key={band.ordinal} className="border-b last:border-b-0">
            <td className="py-1 tabular-nums">{shillings(band.lowerBound)}</td>
            <td className="py-1 tabular-nums">{band.upperBound === null ? "and above" : shillings(band.upperBound)}</td>
            <td className="py-1 text-right tabular-nums">{percent(band.ratePercent)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ScheduleFacts({ schedule }: { schedule: Schedule }) {
  return (
    <div className="space-y-4">
      <Facts
        label={`Statutory schedule ${schedule.label}`}
        facts={[
          ["In force", windowOf(schedule)],
          ["VAT standard rate", `${percent(schedule.vatStandardRate)} — ${schedule.vatRateSource}`],
          ["Turnover Tax rate", `${percent(schedule.totRatePercent)} — ${schedule.totRateSource}`],
          ["Personal relief (monthly)", shillings(schedule.personalRelief)],
          ["NSSF", `${percent(schedule.nssfRatePercent)} each side · Tier I to ${shillings(schedule.nssfLowerLimit)} · capped at ${shillings(schedule.nssfUpperLimit)}`],
          ["SHIF", `${percent(schedule.shifRatePercent)} of gross · at least ${shillings(schedule.shifMinimum)}`],
          ["Housing levy", `${percent(schedule.ahlRatePercent)} each side`],
          ["Payroll figures from", `${schedule.source} (checked ${formatDate(schedule.verifiedOn)})`],
          ["Notes", schedule.notes],
        ]}
      />
      <Bands schedule={schedule} />
    </div>
  );
}

interface BandDraft {
  key: number;
  lower: string;
  upper: string;
  rate: string;
}
interface Draft {
  effectiveFrom: string;
  label: string;
  source: string;
  verifiedOn: string;
  notes: string;
  personalRelief: string;
  nssfRatePercent: string;
  nssfLowerLimit: string;
  nssfUpperLimit: string;
  shifRatePercent: string;
  shifMinimum: string;
  ahlRatePercent: string;
  vatStandardRate: string;
  vatRateSource: string;
  vatRateVerifiedOn: string;
  totRatePercent: string;
  totRateSource: string;
  totRateVerifiedOn: string;
  bands: BandDraft[];
}
type Problems = Partial<Record<Exclude<keyof Draft, "bands">, string>> & { bands?: string };

const MONEY_FIELDS = ["personalRelief", "nssfLowerLimit", "nssfUpperLimit", "shifMinimum"] as const;
const RATE_FIELDS = ["nssfRatePercent", "shifRatePercent", "ahlRatePercent", "vatStandardRate", "totRatePercent"] as const;
const CITATION_FIELDS = ["source", "vatRateSource", "totRateSource"] as const;
const VERIFIED_FIELDS = ["verifiedOn", "vatRateVerifiedOn", "totRateVerifiedOn"] as const;

/** A new version starts as a copy of the one in force — the law usually changes one figure. */
function draftFrom(s: Schedule): Draft {
  return {
    effectiveFrom: "",
    label: "",
    source: s.source,
    verifiedOn: businessToday(),
    notes: "",
    personalRelief: centsToAmount(s.personalRelief),
    nssfRatePercent: s.nssfRatePercent,
    nssfLowerLimit: centsToAmount(s.nssfLowerLimit),
    nssfUpperLimit: centsToAmount(s.nssfUpperLimit),
    shifRatePercent: s.shifRatePercent,
    shifMinimum: centsToAmount(s.shifMinimum),
    ahlRatePercent: s.ahlRatePercent,
    vatStandardRate: s.vatStandardRate,
    vatRateSource: s.vatRateSource,
    vatRateVerifiedOn: businessToday(),
    totRatePercent: s.totRatePercent,
    totRateSource: s.totRateSource,
    totRateVerifiedOn: businessToday(),
    bands: s.bands.map((b) => ({ key: b.ordinal, lower: centsToAmount(b.lowerBound), upper: b.upperBound === null ? "" : centsToAmount(b.upperBound), rate: b.ratePercent })),
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function check(d: Draft, today: string): Problems {
  const p: Problems = {};
  if (!ISO.test(d.effectiveFrom)) p.effectiveFrom = "Choose the date the new rates take effect.";
  else if (d.effectiveFrom <= today) p.effectiveFrom = "Choose a date after today — a new version only ever starts in the future.";
  for (const field of CITATION_FIELDS) if (d[field].trim() === "") p[field] = "Cite where the figure comes from (the Act or the authority).";
  for (const field of VERIFIED_FIELDS) {
    if (!ISO.test(d[field])) p[field] = "Enter the date you checked it.";
    else if (d[field] > today) p[field] = "The check date can’t be in the future.";
  }
  for (const field of MONEY_FIELDS) {
    const problem = shillingsProblem(d[field]);
    if (problem) p[field] = problem;
  }
  for (const field of RATE_FIELDS) {
    if (!RATE.test(d[field].trim())) p[field] = "Enter a percentage, e.g. 16 or 2.75.";
    else if (Number(d[field]) > 100) p[field] = "A rate can’t be more than 100%.";
  }
  if (!p.vatStandardRate && Number(d.vatStandardRate) === 0) p.vatStandardRate = "The VAT rate must be above 0.";
  if (!p.totRatePercent && Number(d.totRatePercent) === 0) p.totRatePercent = "The Turnover Tax rate must be above 0.";
  if (d.bands.length === 0) p.bands = "Add at least one PAYE band.";
  else {
    const bad = d.bands.find((b, i) => shillingsProblem(b.lower) !== null || (i < d.bands.length - 1 ? shillingsProblem(b.upper) !== null : b.upper.trim() !== "" && shillingsProblem(b.upper) !== null) || !RATE.test(b.rate.trim()));
    if (bad) p.bands = "Each band needs a starting amount, an upper amount (empty only on the top band) and a rate.";
    else if (d.bands.at(-1)?.upper.trim() !== "") p.bands = "Leave the top band’s upper amount empty — it has no ceiling.";
  }
  return p;
}

const money = (typed: string) => centsToAmount(parseMajorToCents(typed));
function bodyOf(d: Draft): SupersedeBody {
  return {
    effectiveFrom: d.effectiveFrom,
    ...(d.label.trim() !== "" ? { label: d.label.trim() } : {}),
    source: d.source.trim(),
    verifiedOn: d.verifiedOn,
    ...(d.notes.trim() !== "" ? { notes: d.notes.trim() } : {}),
    personalRelief: money(d.personalRelief),
    nssfRatePercent: d.nssfRatePercent.trim(),
    nssfLowerLimit: money(d.nssfLowerLimit),
    nssfUpperLimit: money(d.nssfUpperLimit),
    shifRatePercent: d.shifRatePercent.trim(),
    shifMinimum: money(d.shifMinimum),
    ahlRatePercent: d.ahlRatePercent.trim(),
    vatStandardRate: d.vatStandardRate.trim(),
    vatRateSource: d.vatRateSource.trim(),
    vatRateVerifiedOn: d.vatRateVerifiedOn,
    totRatePercent: d.totRatePercent.trim(),
    totRateSource: d.totRateSource.trim(),
    totRateVerifiedOn: d.totRateVerifiedOn,
    bands: d.bands.map((b) => ({ lowerBound: money(b.lower), upperBound: b.upper.trim() === "" ? null : money(b.upper), ratePercent: b.rate.trim() })),
  };
}

const LABELS: Readonly<Record<Exclude<keyof Draft, "bands">, string>> = {
  effectiveFrom: "Takes effect from",
  label: "Version name",
  source: "Citation for the payroll figures",
  verifiedOn: "Payroll figures checked on",
  notes: "Notes",
  personalRelief: "Personal relief (KES / month)",
  nssfRatePercent: "NSSF rate (%)",
  nssfLowerLimit: "NSSF Tier I limit (KES)",
  nssfUpperLimit: "NSSF upper limit (KES)",
  shifRatePercent: "SHIF rate (%)",
  shifMinimum: "SHIF minimum (KES)",
  ahlRatePercent: "Housing levy rate (%)",
  vatStandardRate: "VAT standard rate (%)",
  vatRateSource: "Citation for the VAT rate",
  vatRateVerifiedOn: "VAT rate checked on",
  totRatePercent: "Turnover Tax rate (%)",
  totRateSource: "Citation for the TOT rate",
  totRateVerifiedOn: "TOT rate checked on",
};
const OPTIONAL = new Set<keyof Draft>(["label", "notes"]);
const DATES = new Set<keyof Draft>(["effectiveFrom", "verifiedOn", "vatRateVerifiedOn", "totRateVerifiedOn"]);

function SupersedeForm({ current, onClose, onDone }: { current: Schedule; onClose: () => void; onDone: (note: string) => void }) {
  const prefix = useId();
  const confirmId = useId();
  const invalidate = useInvalidateSettings();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(current));
  const [problems, setProblems] = useState<Problems>({});
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const today = businessToday();

  function field(name: Exclude<keyof Draft, "bands">) {
    return (
      <TextField
        id={`${prefix}-${name}`}
        label={LABELS[name]}
        optional={OPTIONAL.has(name)}
        type={DATES.has(name) ? "date" : "text"}
        inputMode={(MONEY_FIELDS as readonly string[]).includes(name) || (RATE_FIELDS as readonly string[]).includes(name) ? "decimal" : undefined}
        autoComplete="off"
        value={draft[name]}
        error={problems[name]}
        onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))}
      />
    );
  }
  const setBand = (key: number, change: Partial<BandDraft>) => setDraft((d) => ({ ...d, bands: d.bands.map((b) => (b.key === key ? { ...b, ...change } : b)) }));

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = check(draft, today);
    setProblems(found);
    if (Object.keys(found).length === 0) setAsking(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const created = await supersedeSchedule(bodyOf(draft));
      await invalidate();
      onDone(`Version ${created.label} takes effect on ${formatDate(created.effectiveFrom)}. ${current.label} governs until the day before. Nothing already posted changes.`);
    } catch (failure) {
      setAsking(false);
      setError(failure instanceof ApiHttpError ? failure.message : "The new version could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate aria-label="New statutory version" onSubmit={submit} className="space-y-6 rounded-lg border p-4">
      <div className="space-y-1">
        <h3 className="font-medium">New version from a future date</h3>
        <p className="text-sm text-muted-foreground">Prefilled from {current.label}. Change what the law changed, cite it and say when you checked it. Every sale, bill and payslip already posted keeps the rates that governed it.</p>
      </div>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">When</legend>
        {field("effectiveFrom")}
        {field("label")}
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-medium">VAT and Turnover Tax</legend>
        {field("vatStandardRate")}
        {field("totRatePercent")}
        {field("vatRateSource")}
        {field("totRateSource")}
        {field("vatRateVerifiedOn")}
        {field("totRateVerifiedOn")}
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-medium">Payroll deductions</legend>
        {field("personalRelief")}
        {field("ahlRatePercent")}
        {field("nssfRatePercent")}
        {field("shifRatePercent")}
        {field("nssfLowerLimit")}
        {field("shifMinimum")}
        {field("nssfUpperLimit")}
        <div />
        {field("source")}
        {field("verifiedOn")}
        <div className="sm:col-span-2">{field("notes")}</div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="mb-2 font-medium">PAYE bands (monthly, lowest first)</legend>
        <ol className="space-y-2">
          {draft.bands.map((band, index) => (
            <li key={band.key} aria-label={`Band ${(index + 1).toString()}`} className="grid grid-cols-[1fr_1fr_6rem_auto] items-end gap-2">
              <TextField id={`${prefix}-band-${band.key.toString()}-lower`} label={`Band ${(index + 1).toString()} from (KES)`} inputMode="decimal" autoComplete="off" value={band.lower} onChange={(e) => setBand(band.key, { lower: e.target.value })} />
              <TextField
                id={`${prefix}-band-${band.key.toString()}-upper`}
                label={`Band ${(index + 1).toString()} up to (KES)`}
                inputMode="decimal"
                autoComplete="off"
                placeholder={index === draft.bands.length - 1 ? "no ceiling" : undefined}
                value={band.upper}
                onChange={(e) => setBand(band.key, { upper: e.target.value })}
              />
              <TextField id={`${prefix}-band-${band.key.toString()}-rate`} label={`Band ${(index + 1).toString()} rate (%)`} inputMode="decimal" autoComplete="off" value={band.rate} onChange={(e) => setBand(band.key, { rate: e.target.value })} />
              <Button type="button" variant="outline" className="h-11 w-11 p-0" aria-label={`Remove band ${(index + 1).toString()}`} disabled={draft.bands.length === 1} onClick={() => setDraft((d) => ({ ...d, bands: d.bands.filter((b) => b.key !== band.key) }))}>
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
        {problems.bands ? <p className="text-sm text-destructive">{problems.bands}</p> : null}
        <Button type="button" variant="outline" className="h-11" onClick={() => setDraft((d) => ({ ...d, bands: [...d.bands, { key: Math.max(0, ...d.bands.map((b) => b.key)) + 1, lower: "", upper: "", rate: "" }] }))}>
          <Plus className="size-4" aria-hidden /> Add a band
        </Button>
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {asking ? (
        <div role="alertdialog" aria-labelledby={confirmId} className="space-y-2 rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-sm">
          <p id={confirmId} className="font-medium">
            Supersede {current.label} from {ISO.test(draft.effectiveFrom) ? formatDate(draft.effectiveFrom) : draft.effectiveFrom}?
          </p>
          <p>From that day every sale, payslip and purchase uses these rates. A version can’t be edited afterwards — a later correction is another new version.</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving} data-autofocus>
              Back
            </Button>
            <Button type="button" className="h-11" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Yes, save the new version"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="h-11" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="h-11">
            Check and save
          </Button>
        </div>
      )}
    </form>
  );
}

export function StatutoryView({ owner }: { owner: boolean }) {
  const historyId = useId();
  const current = useCurrentSchedule();
  const history = useSchedules();
  const [writing, setWriting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {notice ? <Done>{notice}</Done> : null}
      <section className="space-y-3">
        <h2 className="font-medium">In force today</h2>
        {current.isPending ? <LoadingState label="Loading the schedule in force" lines={4} /> : null}
        {current.isError ? (
          current.error instanceof ApiHttpError && current.error.status === 404 ? (
            <EmptyState title="No schedule covers today" description={current.error.message} />
          ) : (
            <ErrorState title="Couldn’t load the schedule in force" description={current.error.message} onRetry={() => void current.refetch()} />
          )
        ) : null}
        {current.isSuccess ? (
          <>
            <p className="text-sm">
              <span className="font-medium">{current.data.label}</span> <span className="text-muted-foreground">· {windowOf(current.data)}</span>
            </p>
            <ScheduleFacts schedule={current.data} />
          </>
        ) : null}
        {owner && current.isSuccess ? (
          writing ? (
            <SupersedeForm
              current={current.data}
              onClose={() => setWriting(false)}
              onDone={(note) => {
                setWriting(false);
                setNotice(note);
              }}
            />
          ) : (
            <Button type="button" className="h-11" onClick={() => setWriting(true)}>
              Set new rates from a future date
            </Button>
          )
        ) : null}
        {!owner ? <p className="text-sm text-muted-foreground">Only the business owner can set new rates.</p> : null}
      </section>
      <section aria-labelledby={historyId} className="space-y-2">
        <h2 id={historyId} className="font-medium">
          Every version
        </h2>
        {history.isPending ? <LoadingState label="Loading the history" lines={3} /> : null}
        {history.isError ? <ErrorState title="Couldn’t load the history" description={history.error.message} onRetry={() => void history.refetch()} /> : null}
        {history.isSuccess ? (
          <ol aria-label="Statutory versions" className="divide-y rounded-lg border text-sm">
            {history.data.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span>
                  <span className="font-medium">{s.label}</span> <span className="text-muted-foreground">· {windowOf(s)}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  VAT {percent(s.vatStandardRate)} · TOT {percent(s.totRatePercent)} · {s.createdById === null ? "system default" : "set by the owner"}
                  {current.data?.id === s.id ? " · in force" : s.effectiveFrom > new Date().toISOString() ? " · upcoming" : ""}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </div>
  );
}
