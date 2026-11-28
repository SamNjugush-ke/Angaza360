"use client";

import { Plus } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, formatDate } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import {
  approveRun,
  cancelRun,
  createRun,
  MONTHS,
  periodName,
  postRun,
  recomputeRun,
  RUN_STATUS_LABEL,
  RUN_STATUS_MEANING,
  RUN_STATUS_ORDER,
  useInvalidatePayroll,
  useRun,
  useRuns,
  type PayrollPermissions,
  type Payslip,
  type RunDetail,
  type RunStatus,
} from "@/lib/payroll/payroll";
import { cn } from "@/lib/utils";

// Payroll runs: one per month, DRAFT → APPROVED → POSTED → PAID. HR computes a DRAFT (nothing is
// posted) and recomputes it after changing someone's terms; the owner or a manager approves it and
// posts the accrual — the salary cost and what is owed to staff and to KRA, NSSF and SHA. A run not
// yet posted can be cancelled, which frees the month. Every figure is the server's gross-to-net
// engine against the statutory schedule in force; the screen only shows it.

const message = (failure: unknown, fallback: string) => (failure instanceof ApiHttpError ? failure.message : fallback);
export const kes = (cents: string) => formatKES(cents);

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full border px-2 py-0.5 text-xs font-medium",
        status === "PAID" ? "border-emerald-700/40 bg-emerald-700/10" : status === "CANCELLED" ? "border-destructive/40 bg-destructive/10" : status === "DRAFT" ? "" : "border-amber-600/40 bg-amber-500/10",
      )}
    >
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}

/** Every payslip of a run, gross to net — a real table, scrollable sideways on a phone. */
export function PayslipTable({ run, onOpen }: { run: RunDetail; onOpen?: (payslip: Payslip) => void }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[44rem] text-sm">
        <caption className="sr-only">
          Payslips of run {run.runNumber.toString()}, {periodName(run.periodYear, run.periodMonth)}, in Kenya shillings
        </caption>
        <thead>
          <tr className="border-b bg-muted/40 text-right text-xs text-muted-foreground">
            <th scope="col" className="p-2 text-left font-medium">
              Employee
            </th>
            <th scope="col" className="p-2 font-medium">
              Gross
            </th>
            <th scope="col" className="p-2 font-medium">
              PAYE
            </th>
            <th scope="col" className="p-2 font-medium">
              NSSF
            </th>
            <th scope="col" className="p-2 font-medium">
              SHIF
            </th>
            <th scope="col" className="p-2 font-medium">
              Housing levy
            </th>
            <th scope="col" className="p-2 font-medium">
              Deductions
            </th>
            <th scope="col" className="p-2 font-medium">
              Net pay
            </th>
          </tr>
        </thead>
        <tbody>
          {run.payslips.map((p) => (
            <tr key={p.id} className="border-b text-right tabular-nums last:border-b-0">
              <th scope="row" className="p-2 text-left font-normal">
                {onOpen ? (
                  <button type="button" className="min-h-11 text-left font-medium text-primary underline underline-offset-4" onClick={() => onOpen(p)}>
                    {p.employeeName}
                  </button>
                ) : (
                  p.employeeName
                )}
              </th>
              <td className="p-2">{kes(p.grossPay)}</td>
              <td className="p-2">{kes(p.paye)}</td>
              <td className="p-2">{kes(p.nssfEmployee)}</td>
              <td className="p-2">{kes(p.shifEmployee)}</td>
              <td className="p-2">{kes(p.ahlEmployee)}</td>
              <td className="p-2">{kes(p.totalEmployeeDeductions)}</td>
              <td className="p-2 font-medium">{kes(p.netPay)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t text-right font-semibold tabular-nums">
            <th scope="row" className="p-2 text-left">
              {run.totals.employeeCount.toString()} {run.totals.employeeCount === 1 ? "employee" : "employees"}
            </th>
            <td className="p-2">{kes(run.totals.grossPay)}</td>
            <td className="p-2">{kes(run.totals.paye)}</td>
            <td className="p-2" colSpan={4} />
            <td className="p-2">{kes(run.totals.netPay)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

type Step = "recompute" | "approve" | "post" | "cancel";
const STEP_WORDS: Readonly<Record<Step, { ask: (period: string) => string; detail: string; yes: string; busy: string }>> = {
  recompute: { ask: (p) => `Recompute the ${p} run?`, detail: "Every payslip is computed again from the employees’ current terms. Nothing is posted.", yes: "Yes, recompute", busy: "Recomputing…" },
  approve: { ask: (p) => `Approve the ${p} run?`, detail: "It can no longer be recomputed. Posting is a separate step.", yes: "Yes, approve", busy: "Approving…" },
  post: { ask: (p) => `Post the ${p} payroll to the books?`, detail: "This books the salary cost and what is owed to staff (net pay) and to KRA, NSSF and SHA. A posted run cannot be cancelled.", yes: "Yes, post it", busy: "Posting…" },
  cancel: { ask: (p) => `Cancel the ${p} run?`, detail: "Nothing has been posted for it. The month is freed for a new run.", yes: "Yes, cancel the run", busy: "Cancelling…" },
};

function RunActions({ run, permissions, onNotice }: { run: RunDetail; permissions: PayrollPermissions; onNotice: (note: string) => void }) {
  const ids = { title: useId(), reason: useId() };
  const invalidate = useInvalidatePayroll();
  const [step, setStep] = useState<Step | null>(null);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const period = periodName(run.periodYear, run.periodMonth);
  const can: Record<Step, boolean> = {
    recompute: run.status === "DRAFT" && permissions.canHr,
    approve: run.status === "DRAFT" && permissions.canApprove,
    post: run.status === "APPROVED" && permissions.canApprove,
    cancel: (run.status === "DRAFT" || run.status === "APPROVED") && permissions.canApprove,
  };

  async function confirm() {
    if (step === null) return;
    if (step === "cancel" && reason.trim() === "") {
      setProblem("Say why it is cancelled — the run keeps the reason.");
      return;
    }
    setProblem(null);
    setSaving(true);
    setError(null);
    try {
      const next =
        step === "recompute" ? await recomputeRun(run.id) : step === "approve" ? await approveRun(run.id) : step === "post" ? await postRun(run.id) : await cancelRun(run.id, reason.trim());
      await invalidate();
      setStep(null);
      setReason("");
      onNotice(
        step === "recompute"
          ? `Recomputed: ${next.totals.employeeCount.toString()} payslips, net pay KES ${kes(next.totals.netPay)}.`
          : step === "approve"
            ? `${period} is approved. Post it to book the payroll.`
            : step === "post"
              ? `${period} is posted. Net pay KES ${kes(next.totals.netPay)} is now owed to staff.`
              : `${period} is cancelled.`,
      );
    } catch (failure) {
      setError(message(failure, "That could not be done. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  const steps = (Object.keys(can) as Step[]).filter((s) => can[s]);
  if (steps.length === 0) return null;
  if (step === null) {
    return (
      <div className="space-y-2">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {can.recompute ? (
            <Button type="button" variant="outline" className="h-11" onClick={() => setStep("recompute")}>
              Recompute
            </Button>
          ) : null}
          {can.approve ? (
            <Button type="button" className="h-11" onClick={() => setStep("approve")}>
              Approve
            </Button>
          ) : null}
          {can.post ? (
            <Button type="button" className="h-11" onClick={() => setStep("post")}>
              Post to the books
            </Button>
          ) : null}
          {can.cancel ? (
            <Button type="button" variant="outline" className="h-11" onClick={() => setStep("cancel")}>
              Cancel run
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  const words = STEP_WORDS[step];
  return (
    <div role="alertdialog" aria-labelledby={ids.title} className="space-y-2 rounded-md border p-3 text-sm">
      <p id={ids.title} className="font-medium">
        {words.ask(period)}
      </p>
      <p>{words.detail}</p>
      {step === "cancel" ? <TextField id={ids.reason} label="Why it is cancelled" autoComplete="off" value={reason} error={problem ?? undefined} onChange={(e) => setReason(e.target.value)} /> : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={() => setStep(null)} disabled={saving} data-autofocus>
          Back
        </Button>
        <Button type="button" className="h-11" variant={step === "cancel" ? "destructive" : "default"} onClick={() => void confirm()} disabled={saving}>
          {saving ? words.busy : words.yes}
        </Button>
      </div>
    </div>
  );
}

export interface RunExtras {
  /** What a run shows below its payslips once the money side exists (settlement, statutory, muster). */
  renderAfter?: (run: RunDetail) => ReactNode;
  /** A payslip opened from the run's table, shown in place of the run with a way back. */
  renderPayslip?: (payslipId: string, back: () => void) => ReactNode;
}

export function RunDetailView({ runId, permissions, extras = {} }: { runId: string; permissions: PayrollPermissions; extras?: RunExtras }) {
  const run = useRun(runId);
  const [notice, setNotice] = useState<string | null>(null);
  const [slip, setSlip] = useState<string | null>(null);
  if (run.isPending) return <LoadingState label="Loading the payroll run" lines={5} />;
  if (run.isError) return <ErrorState title="Couldn’t load the payroll run" description={run.error.message} onRetry={() => void run.refetch()} />;
  const r = run.data;
  if (slip !== null && extras.renderPayslip) return <>{extras.renderPayslip(slip, () => setSlip(null))}</>;
  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <RunStatusBadge status={r.status} />
          <span className="text-sm text-muted-foreground">
            Run {r.runNumber.toString()} · pay date {formatDate(r.payDate)} · rates {r.statutoryScheduleLabel}
          </span>
        </div>
        <p className="text-sm">{RUN_STATUS_MEANING[r.status]}</p>
        {r.notes ? <p className="text-xs text-muted-foreground">Note: {r.notes}</p> : null}
      </div>
      {r.payslips.length === 0 ? <EmptyState title="No payslips" description="No employee was active for this month. Add or reinstate employees, then recompute." /> : <PayslipTable run={r} onOpen={extras.renderPayslip ? (p) => setSlip(p.id) : undefined} />}
      <RunActions run={r} permissions={permissions} onNotice={setNotice} />
      {!permissions.canApprove && (r.status === "DRAFT" || r.status === "APPROVED") ? (
        <p className="text-sm text-muted-foreground">{permissions.canHr ? "The owner or a manager approves and posts the run." : "HR prepares the run; the owner or a manager approves and posts it."}</p>
      ) : null}
      {extras.renderAfter?.(r)}
    </div>
  );
}

function NewRunForm({ onCreated, onCancel }: { onCreated: (run: RunDetail) => void; onCancel: () => void }) {
  const ids = { year: useId(), month: useId(), pay: useId(), notes: useId() };
  const invalidate = useInvalidatePayroll();
  const today = businessToday();
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(today.slice(0, 4));
  const [month, setMonth] = useState(String(Number(today.slice(5, 7))));
  const [payDate, setPayDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
      setProblem("Enter the day net pay is meant to reach staff.");
      return;
    }
    setProblem(null);
    setSaving(true);
    setError(null);
    try {
      const run = await createRun({ periodYear: Number(year), periodMonth: Number(month), payDate, ...(notes.trim() !== "" ? { notes: notes.trim() } : {}) });
      await invalidate();
      onCreated(run);
    } catch (failure) {
      setError(message(failure, "The run could not be created. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate aria-label="New payroll run" onSubmit={(e) => void submit(e)} className="space-y-4">
      <p className="text-sm text-muted-foreground">Every active employee’s payslip is computed from their current terms and the statutory rates in force. Nothing is posted until the run is approved and posted.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField id={ids.month} label="Month" value={month} onChange={setMonth}>
          {MONTHS.map((name, index) => (
            <option key={name} value={String(index + 1)}>
              {name}
            </option>
          ))}
        </SelectField>
        <SelectField id={ids.year} label="Year" value={year} onChange={setYear}>
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </SelectField>
        <TextField id={ids.pay} label="Pay date" type="date" value={payDate} error={problem ?? undefined} hint="The accrual is dated to it." onChange={(e) => setPayDate(e.target.value)} />
        <TextField id={ids.notes} label="Notes" optional autoComplete="off" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" className="h-11" disabled={saving}>
          {saving ? "Computing…" : "Compute the draft run"}
        </Button>
      </div>
    </form>
  );
}

export function RunsView({ permissions, extras }: { permissions: PayrollPermissions; extras?: RunExtras }) {
  const statusId = useId();
  const [status, setStatus] = useState<RunStatus | "">("");
  const runs = useRuns(status);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="sm:w-56">
          <SelectField id={statusId} label="Status" value={status} onChange={(v) => setStatus(v as RunStatus | "")}>
            <option value="">Every run</option>
            {RUN_STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {RUN_STATUS_LABEL[s]}
              </option>
            ))}
          </SelectField>
        </div>
        {permissions.canHr ? (
          <Button type="button" className="h-11" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden /> New run
          </Button>
        ) : null}
      </div>
      {runs.isPending ? <LoadingState label="Loading payroll runs" lines={4} /> : null}
      {runs.isError ? <ErrorState title="Couldn’t load the payroll runs" description={runs.error.message} onRetry={() => void runs.refetch()} /> : null}
      {runs.isSuccess && runs.data.data.length === 0 ? (
        <EmptyState title={status ? "No runs match" : "No payroll runs yet"} description={status ? "Try another status." : permissions.canHr ? "Start with a new run for the month." : "HR prepares each month’s run."} />
      ) : null}
      {runs.isSuccess && runs.data.data.length > 0 ? (
        <ul aria-label="Payroll runs" className="space-y-2">
          {runs.data.data.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setOpen(r.id)}
                aria-label={`${periodName(r.periodYear, r.periodMonth)} · run ${r.runNumber.toString()} · ${RUN_STATUS_LABEL[r.status]}`}
                className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>
                  <span className="font-medium">{periodName(r.periodYear, r.periodMonth)}</span> <span className="text-muted-foreground">· run {r.runNumber.toString()}</span>
                  <span className="block text-xs text-muted-foreground">
                    {r.totals.employeeCount.toString()} employees · gross KES {kes(r.totals.grossPay)} · PAYE KES {kes(r.totals.paye)} · net KES {kes(r.totals.netPay)}
                  </span>
                </span>
                <RunStatusBadge status={r.status} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {creating ? (
        <Sheet title="New payroll run" onClose={() => setCreating(false)}>
          <NewRunForm
            onCancel={() => setCreating(false)}
            onCreated={(run) => {
              setCreating(false);
              setOpen(run.id);
            }}
          />
        </Sheet>
      ) : null}
      {open ? (
        <Sheet key={open} title="Payroll run" onClose={() => setOpen(null)} wide>
          <RunDetailView runId={open} permissions={permissions} extras={extras} />
        </Sheet>
      ) : null}
    </div>
  );
}
