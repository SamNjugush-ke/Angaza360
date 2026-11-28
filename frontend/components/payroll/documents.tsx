"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { DocumentFrame } from "@/components/accounting/statements";
import { TextField } from "@/components/auth/form-bits";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField, shillingsProblem } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, formatDate } from "@/lib/datetime";
import { centsToAmount, formatKES, parseMajorToCents } from "@/lib/money";
import {
  HEAD_KEY,
  HEAD_LABEL,
  HEADS,
  IDENTIFIER_LABEL,
  PAY_METHOD_LABEL,
  periodName,
  remit,
  SETTLEMENT_LABEL,
  settleNet,
  useInvalidatePayroll,
  useMuster,
  useNetPayment,
  usePayslipDocument,
  useStatutorySummary,
  type PayrollPermissions,
  type RunDetail,
  type SettlementMethod,
  type StatutorySummary,
  type StatutoryType,
} from "@/lib/payroll/payroll";

// The payroll documents and the money that follows a posted run. Each document is the server's
// structured JSON laid out as a printable A4 page with real table semantics: the payslip (handed to
// the employee), the four statutory filing schedules and the muster roll. Recomputing nothing — every
// figure is read. Paying net pay and remitting a head post to the books, so they are the owner's or a
// manager's; the server refuses a closed period or more than is owed, in its own words.

const message = (failure: unknown, fallback: string) => (failure instanceof ApiHttpError ? failure.message : fallback);
const kes = (cents: string) => formatKES(cents);
const SETTLEMENT_METHODS: readonly SettlementMethod[] = ["BANK", "MPESA", "CASH"];

function Num({ children, strong = false }: { children: string; strong?: boolean }) {
  return <td className={strong ? "py-1 text-right font-semibold tabular-nums" : "py-1 text-right tabular-nums"}>{children}</td>;
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr className="border-b last:border-b-0">
      <th scope="row" className={strong ? "py-1 text-left font-semibold" : "py-1 text-left font-normal"}>
        {label}
      </th>
      <Num strong={strong}>{value}</Num>
    </tr>
  );
}

function Block({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <table className="w-full text-sm">
      <caption className="pb-1 text-left font-semibold">{caption}</caption>
      <tbody>{children}</tbody>
    </table>
  );
}

// ---- The payslip ----

export function PayslipDocumentView({ payslipId }: { payslipId: string }) {
  const doc = usePayslipDocument(payslipId);
  if (doc.isPending) return <LoadingState label="Loading the payslip" lines={6} />;
  if (doc.isError) return <ErrorState title="Couldn’t load the payslip" description={doc.error.message} onRetry={() => void doc.refetch()} />;
  const d = doc.data;
  const id = (value: string | null) => value ?? "Not recorded";
  return (
    <DocumentFrame title="Payslip" subtitle={`${d.employer.name} · ${periodName(d.run.periodYear, d.run.periodMonth)} · pay date ${formatDate(d.run.payDate)}`} note={`Computed under the statutory schedule ${d.run.statutoryScheduleLabel}.`}>
      <div className="grid gap-4 text-sm sm:grid-cols-2">
        <dl aria-label="Employee">
          {(
            [
              ["Employee", `${d.employee.name} (#${d.employee.employeeNumber.toString()})`],
              ["National ID", id(d.employee.nationalId)],
              ["KRA PIN", id(d.employee.kraPin)],
              ["NSSF number", id(d.employee.nssfNumber)],
              ["SHIF number", id(d.employee.shifNumber)],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b py-1">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
        <dl aria-label="Payment">
          <div className="flex justify-between gap-3 border-b py-1">
            <dt className="text-muted-foreground">Run</dt>
            <dd>{d.run.runNumber.toString()}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b py-1">
            <dt className="text-muted-foreground">Payment</dt>
            <dd className="text-right">
              {d.payment.status === "PAID"
                ? `Paid${d.payment.paymentDate ? ` ${formatDate(d.payment.paymentDate)}` : ""}${d.payment.employeeMethod ? ` by ${PAY_METHOD_LABEL[d.payment.employeeMethod].toLowerCase()}` : ""}`
                : "Not yet paid"}
            </dd>
          </div>
        </dl>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <Block caption="Earnings">
          {d.earnings.map((e) => (
            <Line key={e.name} label={`${e.name}${e.taxable ? "" : " (non-taxable)"}`} value={kes(e.amount)} />
          ))}
          <Line label="Gross pay" value={kes(d.grossPay)} strong />
        </Block>
        <Block caption="Deductions">
          <Line label="NSSF" value={kes(d.deductions.nssf)} />
          <Line label="SHIF" value={kes(d.deductions.shif)} />
          <Line label="Housing levy" value={kes(d.deductions.housingLevy)} />
          <Line label="PAYE" value={kes(d.deductions.paye)} />
          <Line label="Total deductions" value={kes(d.deductions.total)} strong />
        </Block>
        <Block caption="How PAYE was worked out">
          <Line label="Taxable pay (after NSSF, SHIF, housing levy)" value={kes(d.tax.taxablePay)} />
          <Line label="Tax on taxable pay" value={kes(d.tax.payeBeforeRelief)} />
          <Line label="Less personal relief" value={kes(d.tax.personalReliefApplied)} />
          <Line label="PAYE" value={kes(d.tax.paye)} strong />
        </Block>
        <Block caption="Paid by the employer on top">
          <Line label="NSSF (employer)" value={kes(d.employerContributions.nssf)} />
          <Line label="Housing levy (employer)" value={kes(d.employerContributions.housingLevy)} />
          <Line label="Total" value={kes(d.employerContributions.total)} strong />
        </Block>
      </div>
      <p className="flex justify-between rounded-md border-2 px-3 py-2 text-base font-semibold">
        <span>Net pay</span>
        <span className="tabular-nums">KES {kes(d.netPay)}</span>
      </p>
    </DocumentFrame>
  );
}

// ---- The muster roll ----

const MUSTER_COLUMNS = [
  ["grossPay", "Gross"],
  ["nssf", "NSSF"],
  ["shif", "SHIF"],
  ["housingLevy", "Housing levy"],
  ["paye", "PAYE"],
  ["totalDeductions", "Deductions"],
  ["netPay", "Net pay"],
  ["employerNssf", "Employer NSSF"],
  ["employerHousingLevy", "Employer levy"],
] as const;

export function MusterView({ runId }: { runId: string }) {
  const muster = useMuster(runId);
  if (muster.isPending) return <LoadingState label="Loading the muster roll" lines={5} />;
  if (muster.isError) return <ErrorState title="Couldn’t load the muster roll" description={muster.error.message} onRetry={() => void muster.refetch()} />;
  const m = muster.data;
  return (
    <DocumentFrame
      title="Muster roll"
      subtitle={`${m.employer.name} · ${periodName(m.run.periodYear, m.run.periodMonth)} · run ${m.run.runNumber.toString()} · ${m.employeeCount.toString()} employees`}
      note={m.reconciles ? "Every row adds up: gross less deductions equals net, and the total net agrees with the books." : "Warning: this muster does not reconcile — tell your accountant before paying."}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm">
          <caption className="sr-only">Muster roll in Kenya shillings</caption>
          <thead>
            <tr className="border-b text-right text-xs text-muted-foreground">
              <th scope="col" className="py-1 text-left font-medium">
                Employee
              </th>
              {MUSTER_COLUMNS.map(([key, label]) => (
                <th key={key} scope="col" className="py-1 pl-2 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.rows.map((row) => (
              <tr key={row.payslipId} className="border-b">
                <th scope="row" className="py-1 text-left font-normal">
                  {row.employeeName} <span className="text-muted-foreground">#{row.employeeNumber.toString()}</span>
                </th>
                {MUSTER_COLUMNS.map(([key]) => (
                  <td key={key} className="py-1 pl-2 text-right tabular-nums">
                    {kes(row[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <th scope="row" className="py-1 text-left">
                Totals
              </th>
              {MUSTER_COLUMNS.map(([key]) => (
                <td key={key} className="py-1 pl-2 text-right tabular-nums">
                  {kes(m.totals[key])}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </DocumentFrame>
  );
}

// ---- Net settlement ----

function SettleForm({ run, onDone }: { run: RunDetail; onDone: (note: string) => void }) {
  const ids = { date: useId(), method: useId(), ref: useId(), title: useId() };
  const invalidate = useInvalidatePayroll();
  const [paymentDate, setPaymentDate] = useState(businessToday());
  const [method, setMethod] = useState<SettlementMethod>("BANK");
  const [reference, setReference] = useState("");
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
      setProblem("Enter the day the money left.");
      return;
    }
    setProblem(null);
    setAsking(true);
  }
  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      const paid = await settleNet(run.id, { paymentDate, method, ...(reference.trim() !== "" ? { reference: reference.trim() } : {}) });
      await invalidate();
      setAsking(false);
      onDone(`Net pay of KES ${kes(paid.totalNet)} is paid from ${SETTLEMENT_LABEL[paid.method].toLowerCase()}. The run is paid.`);
    } catch (failure) {
      setAsking(false);
      setError(message(failure, "Net pay could not be recorded. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form noValidate aria-label="Pay net pay" onSubmit={submit} className="space-y-3 rounded-lg border p-3">
      <h3 className="font-medium">Pay net pay — KES {kes(run.totals.netPay)}</h3>
      <p className="text-sm text-muted-foreground">Records the whole run’s net pay leaving one account. Each employee’s own method and account are kept on their line for the bank file. It disburses nothing by itself.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id={ids.date} label="Payment date" type="date" value={paymentDate} error={problem ?? undefined} onChange={(e) => setPaymentDate(e.target.value)} />
        <SelectField id={ids.method} label="Paid from" value={method} onChange={(v) => setMethod(v as SettlementMethod)}>
          {SETTLEMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {SETTLEMENT_LABEL[m]}
            </option>
          ))}
        </SelectField>
        <TextField id={ids.ref} label="Reference" optional autoComplete="off" hint="A bank batch or transfer reference." value={reference} onChange={(e) => setReference(e.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {asking ? (
        <div role="alertdialog" aria-labelledby={ids.title} className="space-y-2 rounded-md border p-3 text-sm">
          <p id={ids.title} className="font-medium">
            Record KES {kes(run.totals.netPay)} of net pay paid on {formatDate(paymentDate)}?
          </p>
          <p>It posts to the books and marks the run paid. It can’t be undone.</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving} data-autofocus>
              Back
            </Button>
            <Button type="button" className="h-11" onClick={() => void confirm()} disabled={saving}>
              {saving ? "Recording…" : "Yes, record the payment"}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" className="h-11">
          Pay net pay
        </Button>
      )}
    </form>
  );
}

export function NetPaymentView({ runId }: { runId: string }) {
  const net = useNetPayment(runId, true);
  if (net.isPending) return <LoadingState label="Loading the net-pay settlement" lines={4} />;
  if (net.isError) return <ErrorState title="Couldn’t load the net-pay settlement" description={net.error.message} onRetry={() => void net.refetch()} />;
  const n = net.data;
  return (
    <section aria-label="Net pay settlement" className="space-y-2 text-sm">
      <h3 className="font-medium">Net pay paid</h3>
      <p>
        KES {kes(n.totalNet)} on {formatDate(n.paymentDate)} from {SETTLEMENT_LABEL[n.method].toLowerCase()}
        {n.reference ? ` · ref ${n.reference}` : ""}.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[32rem]">
          <caption className="sr-only">Net pay by employee, in Kenya shillings</caption>
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th scope="col" className="p-2 font-medium">
                Employee
              </th>
              <th scope="col" className="p-2 font-medium">
                Paid by
              </th>
              <th scope="col" className="p-2 font-medium">
                Account
              </th>
              <th scope="col" className="p-2 text-right font-medium">
                Net pay
              </th>
            </tr>
          </thead>
          <tbody>
            {n.lines.map((line) => (
              <tr key={line.id} className="border-b last:border-b-0">
                <th scope="row" className="p-2 text-left font-normal">
                  {line.employeeName}
                </th>
                <td className="p-2">{PAY_METHOD_LABEL[line.method]}</td>
                <td className="p-2">{[line.bankName, line.bankAccount].filter(Boolean).join(" · ") || "—"}</td>
                <td className="p-2 text-right tabular-nums">{kes(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Settlement({ run, permissions }: { run: RunDetail; permissions: PayrollPermissions }) {
  const [notice, setNotice] = useState<string | null>(null);
  if (run.status === "PAID") return <NetPaymentView runId={run.id} />;
  if (run.status !== "POSTED") return null;
  return (
    <div className="space-y-2">
      {notice ? <Done>{notice}</Done> : null}
      {permissions.canApprove ? <SettleForm run={run} onDone={setNotice} /> : <p className="text-sm text-muted-foreground">Net pay of KES {kes(run.totals.netPay)} is owed. The owner or a manager records paying it.</p>}
    </div>
  );
}

// ---- Statutory: the four schedules, and remitting a head ----

function RemitForm({ runId, head, outstanding, onDone, onCancel }: { runId: string; head: StatutoryType; outstanding: string; onDone: (note: string) => void; onCancel: () => void }) {
  const ids = { amount: useId(), date: useId(), method: useId(), ref: useId() };
  const invalidate = useInvalidatePayroll();
  const [amount, setAmount] = useState(centsToAmount(outstanding));
  const [date, setDate] = useState(businessToday());
  const [method, setMethod] = useState<SettlementMethod>("BANK");
  const [reference, setReference] = useState("");
  const [problems, setProblems] = useState<{ amount?: string; date?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: typeof problems = {};
    const amountProblem = shillingsProblem(amount, { allowZero: false });
    if (amountProblem) next.amount = amountProblem;
    else if (parseMajorToCents(amount) > BigInt(outstanding)) next.amount = `That is more than is owed for this run (KES ${kes(outstanding)}).`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) next.date = "Enter the day the money left.";
    setProblems(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const done = await remit({ statutoryType: head, amount: centsToAmount(parseMajorToCents(amount)), remittanceDate: date, method, payrollRunId: runId, ...(reference.trim() !== "" ? { reference: reference.trim() } : {}) });
      await invalidate();
      onDone(`${HEAD_LABEL[head]} of KES ${kes(done.amount)} remitted to ${done.authority}.`);
    } catch (failure) {
      setError(message(failure, "The remittance could not be recorded. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form noValidate aria-label={`Remit ${HEAD_LABEL[head]}`} onSubmit={(e) => void submit(e)} className="no-print space-y-3 rounded-md border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id={ids.amount} label="Amount (KES)" inputMode="decimal" autoComplete="off" value={amount} error={problems.amount} onChange={(e) => setAmount(e.target.value)} />
        <TextField id={ids.date} label="Date paid" type="date" value={date} error={problems.date} onChange={(e) => setDate(e.target.value)} />
        <SelectField id={ids.method} label="Paid from" value={method} onChange={(v) => setMethod(v as SettlementMethod)}>
          {SETTLEMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {SETTLEMENT_LABEL[m]}
            </option>
          ))}
        </SelectField>
        <TextField id={ids.ref} label="Authority’s reference" optional autoComplete="off" hint="e.g. the KRA PRN or the NSSF / SHA receipt." value={reference} onChange={(e) => setReference(e.target.value)} />
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
          {saving ? "Recording…" : `Record the ${HEAD_LABEL[head]} payment`}
        </Button>
      </div>
    </form>
  );
}

type Schedule = StatutorySummary["paye"] | StatutorySummary["nssf"] | StatutorySummary["shif"] | StatutorySummary["housingLevy"];

function ScheduleTable({ head, summary }: { head: StatutoryType; summary: StatutorySummary }) {
  const caption = `${HEAD_LABEL[head]} — in Kenya shillings`;
  const header = (cols: readonly string[]) => (
    <thead>
      <tr className="border-b text-right text-xs text-muted-foreground">
        <th scope="col" className="py-1 text-left font-medium">
          Employee
        </th>
        {cols.map((c) => (
          <th key={c} scope="col" className="py-1 pl-2 font-medium">
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
  const cell = (v: string | null, text = false) => <td className={text ? "py-1 pl-2 text-right" : "py-1 pl-2 text-right tabular-nums"}>{v === null ? "missing" : text ? v : kes(v)}</td>;
  const name = (row: { employeeName: string; employeeNumber: number }) => (
    <th scope="row" className="py-1 text-left font-normal">
      {row.employeeName}
    </th>
  );
  const total = (label: string) => (
    <th scope="row" className="py-1 text-left">
      {label}
    </th>
  );
  let body: ReactNode;
  if (head === "PAYE") {
    const s = summary.paye;
    body = (
      <>
        {header(["KRA PIN", "Gross", "Taxable", "Tax", "Relief", "PAYE"])}
        <tbody>
          {s.rows.map((r) => (
            <tr key={r.employeeId} className="border-b">
              {name(r)}
              {cell(r.kraPin, true)}
              {cell(r.grossPay)}
              {cell(r.taxablePay)}
              {cell(r.payeBeforeRelief)}
              {cell(r.personalReliefApplied)}
              {cell(r.paye)}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            {total("Total")}
            <td />
            {cell(s.totals.grossPay)}
            {cell(s.totals.taxablePay)}
            {cell(s.totals.payeBeforeRelief)}
            {cell(s.totals.personalReliefApplied)}
            {cell(s.totals.paye)}
          </tr>
        </tfoot>
      </>
    );
  } else if (head === "NSSF") {
    const s = summary.nssf;
    body = (
      <>
        {header(["NSSF no.", "Gross", "Tier I", "Tier II", "Employee", "Employer", "Total"])}
        <tbody>
          {s.rows.map((r) => (
            <tr key={r.employeeId} className="border-b">
              {name(r)}
              {cell(r.nssfNumber, true)}
              {cell(r.grossPay)}
              {cell(r.tier1)}
              {cell(r.tier2)}
              {cell(r.employee)}
              {cell(r.employer)}
              {cell(r.total)}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            {total("Total")}
            <td />
            {cell(s.totals.grossPay)}
            {cell(s.totals.tier1)}
            {cell(s.totals.tier2)}
            {cell(s.totals.employee)}
            {cell(s.totals.employer)}
            {cell(s.totals.total)}
          </tr>
        </tfoot>
      </>
    );
  } else if (head === "SHIF") {
    const s = summary.shif;
    body = (
      <>
        {header(["SHIF no.", "Gross", "SHIF"])}
        <tbody>
          {s.rows.map((r) => (
            <tr key={r.employeeId} className="border-b">
              {name(r)}
              {cell(r.shifNumber, true)}
              {cell(r.grossPay)}
              {cell(r.shif)}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            {total("Total")}
            <td />
            {cell(s.totals.grossPay)}
            {cell(s.totals.shif)}
          </tr>
        </tfoot>
      </>
    );
  } else {
    const s = summary.housingLevy;
    body = (
      <>
        {header(["KRA PIN", "Gross", "Employee", "Employer", "Total"])}
        <tbody>
          {s.rows.map((r) => (
            <tr key={r.employeeId} className="border-b">
              {name(r)}
              {cell(r.kraPin, true)}
              {cell(r.grossPay)}
              {cell(r.employee)}
              {cell(r.employer)}
              {cell(r.total)}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            {total("Total")}
            <td />
            {cell(s.totals.grossPay)}
            {cell(s.totals.employee)}
            {cell(s.totals.employer)}
            {cell(s.totals.total)}
          </tr>
        </tfoot>
      </>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <caption className="sr-only">{caption}</caption>
        {body}
      </table>
    </div>
  );
}

function HeadSection({ head, summary, runId, permissions }: { head: StatutoryType; summary: StatutorySummary; runId: string; permissions: PayrollPermissions }) {
  const heading = useId();
  const [remitting, setRemitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const s: Schedule = summary[HEAD_KEY[head]];
  const owed = s.outstanding !== null && BigInt(s.outstanding) > 0n;
  return (
    <section aria-labelledby={heading} className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={heading} className="font-semibold">
          {HEAD_LABEL[head]} <span className="font-normal text-muted-foreground">— pay to {s.authority} (account {s.accountCode})</span>
        </h3>
        <p className="text-sm tabular-nums">
          Due KES {kes(s.total)} · remitted KES {kes(s.remitted)}
          {s.outstanding !== null ? ` · outstanding KES ${kes(s.outstanding)}` : " · not posted yet"}
        </p>
      </div>
      <ScheduleTable head={head} summary={summary} />
      {s.missingIdentifiers.length > 0 ? (
        <p className="text-sm text-destructive">
          Not ready to file — missing: {s.missingIdentifiers.map((m) => `${m.employeeName}’s ${IDENTIFIER_LABEL[m.field]}`).join(", ")}. Add them on the Employees tab.
        </p>
      ) : null}
      {notice ? <Done>{notice}</Done> : null}
      {permissions.canApprove && owed ? (
        remitting ? (
          <RemitForm
            runId={runId}
            head={head}
            outstanding={s.outstanding ?? "0"}
            onCancel={() => setRemitting(false)}
            onDone={(note) => {
              setRemitting(false);
              setNotice(note);
            }}
          />
        ) : (
          <Button type="button" variant="outline" className="no-print h-11" onClick={() => setRemitting(true)}>
            Remit {HEAD_LABEL[head]}
          </Button>
        )
      ) : null}
    </section>
  );
}

export function StatutorySummaryView({ runId, permissions }: { runId: string; permissions: PayrollPermissions }) {
  const summary = useStatutorySummary(runId);
  if (summary.isPending) return <LoadingState label="Loading the statutory schedules" lines={6} />;
  if (summary.isError) return <ErrorState title="Couldn’t load the statutory schedules" description={summary.error.message} onRetry={() => void summary.refetch()} />;
  const s = summary.data;
  return (
    <DocumentFrame
      title="Statutory schedules"
      subtitle={`${s.employer.name} · ${periodName(s.run.periodYear, s.run.periodMonth)} · run ${s.run.runNumber.toString()}`}
      note={s.fileable ? "Every schedule agrees with the payslips and the books, and no identifier is missing: ready to file." : "Not yet ready to file: a schedule is unposted, does not agree with the books, or is missing an employee identifier."}
    >
      {HEADS.map((head) => (
        <HeadSection key={head} head={head} summary={s} runId={runId} permissions={permissions} />
      ))}
    </DocumentFrame>
  );
}
