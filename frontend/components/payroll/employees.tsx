"use client";

import { Plus, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField, shillingsProblem } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, formatDate } from "@/lib/datetime";
import { centsToAmount, formatKES, parseMajorToCents } from "@/lib/money";
import {
  createEmployee,
  EMPLOYEE_STATUS_LABEL,
  EMPLOYMENT_TYPE_LABEL,
  PAY_METHOD_LABEL,
  setEmployeeStatus,
  updateEmployee,
  useEmployee,
  useEmployees,
  useInvalidatePayroll,
  type Employee,
  type EmployeeBody,
  type EmployeeStatus,
  type EmploymentType,
  type PayMethod,
  type PayrollPermissions,
} from "@/lib/payroll/payroll";
import { cn } from "@/lib/utils";

// The employee master: standing monthly terms (basic pay, fixed allowances), the identifiers each
// authority files by, and how net pay reaches the person. HR keeps it (owner, manager, HR officer);
// the accountant and auditor read it. A change of terms affects the NEXT run — a computed payslip
// never changes. Suspending or terminating drops someone from new runs and deletes nothing.

const message = (failure: unknown, fallback: string) => (failure instanceof ApiHttpError ? failure.message : fallback);
const kes = (cents: string) => `KES ${formatKES(cents)}`;

export function EmployeeStatusBadge({ status }: { status: EmployeeStatus }) {
  return (
    <span className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-medium", status === "ACTIVE" ? "border-emerald-700/40 bg-emerald-700/10" : status === "SUSPENDED" ? "border-amber-600/40 bg-amber-500/10" : "border-destructive/40 bg-destructive/10")}>
      {EMPLOYEE_STATUS_LABEL[status]}
    </span>
  );
}

interface AllowanceDraft {
  key: number;
  name: string;
  amount: string;
  taxable: boolean;
}
interface Draft {
  firstName: string;
  lastName: string;
  nationalId: string;
  kraPin: string;
  nssfNumber: string;
  shifNumber: string;
  employmentType: EmploymentType;
  hireDate: string;
  basicSalary: string;
  paymentMethod: PayMethod;
  bankName: string;
  bankAccount: string;
  allowances: AllowanceDraft[];
}
type Problems = Partial<Record<Exclude<keyof Draft, "allowances">, string>> & { allowances?: string };

const blank = (): Draft => ({
  firstName: "",
  lastName: "",
  nationalId: "",
  kraPin: "",
  nssfNumber: "",
  shifNumber: "",
  employmentType: "PERMANENT",
  hireDate: businessToday(),
  basicSalary: "",
  paymentMethod: "BANK",
  bankName: "",
  bankAccount: "",
  allowances: [],
});

const draftOf = (e: Employee): Draft => ({
  firstName: e.firstName,
  lastName: e.lastName,
  nationalId: e.nationalId ?? "",
  kraPin: e.kraPin ?? "",
  nssfNumber: e.nssfNumber ?? "",
  shifNumber: e.shifNumber ?? "",
  employmentType: e.employmentType,
  hireDate: e.hireDate.slice(0, 10),
  basicSalary: centsToAmount(e.basicSalary),
  paymentMethod: e.paymentMethod,
  bankName: e.bankName ?? "",
  bankAccount: e.bankAccount ?? "",
  allowances: e.allowances.map((a, index) => ({ key: index + 1, name: a.name, amount: centsToAmount(a.amount), taxable: a.taxable })),
});

function check(d: Draft, creating: boolean): Problems {
  const p: Problems = {};
  if (d.firstName.trim() === "") p.firstName = "Enter the first name.";
  if (d.lastName.trim() === "") p.lastName = "Enter the last name.";
  if (creating && !/^\d{4}-\d{2}-\d{2}$/.test(d.hireDate)) p.hireDate = "Enter the date they started.";
  const salary = shillingsProblem(d.basicSalary);
  if (salary) p.basicSalary = salary;
  const pin = d.kraPin.trim().toUpperCase();
  if (pin !== "" && !/^[A-Z]\d{9}[A-Z]$/.test(pin)) p.kraPin = "A KRA PIN is a letter, nine digits and a letter, e.g. A012345678Z.";
  if (d.paymentMethod === "BANK" && (d.bankName.trim() === "" || d.bankAccount.trim() === "")) p.bankAccount = "Enter the bank and the account number net pay goes to.";
  if (d.paymentMethod === "MPESA" && !/^\+?\d{9,15}$/.test(d.bankAccount.trim().replace(/\s/g, ""))) p.bankAccount = "Enter the M-Pesa number net pay goes to, e.g. 0712345678.";
  if (d.allowances.some((a) => a.name.trim() === "" || shillingsProblem(a.amount) !== null)) p.allowances = "Each allowance needs a name and a monthly amount in shillings.";
  return p;
}

const money = (typed: string) => centsToAmount(parseMajorToCents(typed));
const allowancesOf = (d: Draft) => d.allowances.map((a) => ({ name: a.name.trim(), amount: money(a.amount), taxable: a.taxable }));
/** Where net pay goes: the bank and account, or the M-Pesa number (kept in the account field). */
const destination = (d: Draft) =>
  d.paymentMethod === "BANK" ? { bankName: d.bankName.trim(), bankAccount: d.bankAccount.trim() } : d.paymentMethod === "MPESA" ? { bankName: null, bankAccount: d.bankAccount.trim().replace(/\s/g, "") } : { bankName: null, bankAccount: null };

function createBody(d: Draft): EmployeeBody {
  const opt = (value: string) => (value.trim() === "" ? undefined : value.trim());
  const where = destination(d);
  return {
    firstName: d.firstName.trim(),
    lastName: d.lastName.trim(),
    ...(opt(d.nationalId) ? { nationalId: opt(d.nationalId) } : {}),
    ...(opt(d.kraPin) ? { kraPin: d.kraPin.trim().toUpperCase() } : {}),
    ...(opt(d.nssfNumber) ? { nssfNumber: opt(d.nssfNumber) } : {}),
    ...(opt(d.shifNumber) ? { shifNumber: opt(d.shifNumber) } : {}),
    employmentType: d.employmentType,
    hireDate: d.hireDate,
    basicSalary: money(d.basicSalary),
    paymentMethod: d.paymentMethod,
    ...(where.bankName ? { bankName: where.bankName } : {}),
    ...(where.bankAccount ? { bankAccount: where.bankAccount } : {}),
    allowances: allowancesOf(d),
  };
}

function updateBody(d: Draft) {
  const orNull = (value: string) => (value.trim() === "" ? null : value.trim());
  return {
    firstName: d.firstName.trim(),
    lastName: d.lastName.trim(),
    nationalId: orNull(d.nationalId),
    kraPin: d.kraPin.trim() === "" ? null : d.kraPin.trim().toUpperCase(),
    nssfNumber: orNull(d.nssfNumber),
    shifNumber: orNull(d.shifNumber),
    employmentType: d.employmentType,
    basicSalary: money(d.basicSalary),
    paymentMethod: d.paymentMethod,
    ...destination(d),
    allowances: allowancesOf(d),
  };
}

function EmployeeForm({ employee, onDone, onCancel }: { employee: Employee | null; onDone: (saved: Employee, note: string) => void; onCancel: () => void }) {
  const prefix = useId();
  const invalidate = useInvalidatePayroll();
  const creating = employee === null;
  const [draft, setDraft] = useState<Draft>(() => (employee ? draftOf(employee) : blank()));
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const text = (name: Exclude<keyof Draft, "allowances" | "employmentType" | "paymentMethod">, label: string, extra: { optional?: boolean; type?: string; hint?: string; inputMode?: "decimal" | "tel" } = {}) => (
    <TextField
      id={`${prefix}-${name}`}
      label={label}
      optional={extra.optional}
      type={extra.type ?? "text"}
      inputMode={extra.inputMode}
      autoComplete="off"
      hint={extra.hint}
      value={draft[name]}
      error={problems[name]}
      onChange={(e) => set(name, e.target.value)}
    />
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = check(draft, creating);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const saved = creating ? await createEmployee(createBody(draft)) : await updateEmployee(employee.id, updateBody(draft));
      await invalidate();
      onDone(saved, creating ? `${saved.firstName} ${saved.lastName} is employee ${saved.employeeNumber.toString()}, on the next payroll run.` : "Saved. The new terms apply from the next run (or a recompute of a draft).");
    } catch (failure) {
      setError(message(failure, "The employee could not be saved. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate aria-label={creating ? "New employee" : "Edit employee"} onSubmit={(e) => void submit(e)} className="space-y-5">
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-medium">Who</legend>
        {text("firstName", "First name")}
        {text("lastName", "Last name")}
        {text("nationalId", "National ID", { optional: true })}
        {text("kraPin", "KRA PIN", { optional: true, hint: "Needed before PAYE can be filed." })}
        {text("nssfNumber", "NSSF number", { optional: true })}
        {text("shifNumber", "SHIF number", { optional: true })}
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-medium">Terms</legend>
        <SelectField id={`${prefix}-type`} label="Employment type" value={draft.employmentType} onChange={(v) => set("employmentType", v as EmploymentType)}>
          {(Object.keys(EMPLOYMENT_TYPE_LABEL) as EmploymentType[]).map((t) => (
            <option key={t} value={t}>
              {EMPLOYMENT_TYPE_LABEL[t]}
            </option>
          ))}
        </SelectField>
        {creating ? text("hireDate", "Start date", { type: "date" }) : <p className="self-end text-sm text-muted-foreground">Started {formatDate(employee.hireDate)}</p>}
        {text("basicSalary", "Basic pay (KES / month)", { inputMode: "decimal" })}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="mb-2 font-medium">Fixed monthly allowances</legend>
        {draft.allowances.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : null}
        <ol className="space-y-2">
          {draft.allowances.map((a, index) => (
            <li key={a.key} aria-label={`Allowance ${(index + 1).toString()}`} className="grid grid-cols-[1fr_8rem_auto] items-end gap-2 sm:grid-cols-[1fr_9rem_auto_auto]">
              <TextField id={`${prefix}-al-${a.key.toString()}-name`} label={`Allowance ${(index + 1).toString()} name`} autoComplete="off" value={a.name} onChange={(e) => set("allowances", draft.allowances.map((x) => (x.key === a.key ? { ...x, name: e.target.value } : x)))} />
              <TextField id={`${prefix}-al-${a.key.toString()}-amount`} label="Amount (KES)" inputMode="decimal" autoComplete="off" value={a.amount} onChange={(e) => set("allowances", draft.allowances.map((x) => (x.key === a.key ? { ...x, amount: e.target.value } : x)))} />
              <div className="col-span-1 flex min-h-11 items-center gap-2 sm:col-auto">
                <input id={`${prefix}-al-${a.key.toString()}-tax`} type="checkbox" className="size-5" checked={a.taxable} onChange={(e) => set("allowances", draft.allowances.map((x) => (x.key === a.key ? { ...x, taxable: e.target.checked } : x)))} />
                <label htmlFor={`${prefix}-al-${a.key.toString()}-tax`} className="text-sm">
                  Taxable
                </label>
              </div>
              <Button type="button" variant="outline" className="h-11 w-11 p-0" aria-label={`Remove allowance ${(index + 1).toString()}`} onClick={() => set("allowances", draft.allowances.filter((x) => x.key !== a.key))}>
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
        {problems.allowances ? <p className="text-sm text-destructive">{problems.allowances}</p> : null}
        <Button type="button" variant="outline" className="h-11" onClick={() => set("allowances", [...draft.allowances, { key: Math.max(0, ...draft.allowances.map((x) => x.key)) + 1, name: "", amount: "", taxable: true }])}>
          <Plus className="size-4" aria-hidden /> Add an allowance
        </Button>
        <p className="text-xs text-muted-foreground">A non-taxable allowance still counts towards NSSF, SHIF and the housing levy.</p>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-medium">How net pay is paid</legend>
        <SelectField id={`${prefix}-method`} label="Payment method" value={draft.paymentMethod} onChange={(v) => set("paymentMethod", v as PayMethod)}>
          {(Object.keys(PAY_METHOD_LABEL) as PayMethod[]).map((m) => (
            <option key={m} value={m}>
              {PAY_METHOD_LABEL[m]}
            </option>
          ))}
        </SelectField>
        {draft.paymentMethod === "BANK" ? text("bankName", "Bank") : null}
        {draft.paymentMethod === "BANK" ? text("bankAccount", "Account number") : null}
        {draft.paymentMethod === "MPESA" ? text("bankAccount", "M-Pesa number", { type: "tel", inputMode: "tel" }) : null}
      </fieldset>
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
          {saving ? "Saving…" : creating ? "Add employee" : "Save terms"}
        </Button>
      </div>
    </form>
  );
}

function StatusChange({ employee, onDone }: { employee: Employee; onDone: (note: string) => void }) {
  const ids = { title: useId(), date: useId() };
  const invalidate = useInvalidatePayroll();
  const [target, setTarget] = useState<EmployeeStatus | null>(null);
  const [date, setDate] = useState(businessToday());
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const name = `${employee.firstName} ${employee.lastName}`;

  async function confirm() {
    if (target === "TERMINATED" && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setProblem("Enter their last day.");
      return;
    }
    setProblem(null);
    setSaving(true);
    setError(null);
    try {
      await setEmployeeStatus(employee.id, target === "TERMINATED" ? { status: target, terminationDate: date } : { status: target ?? "ACTIVE" });
      await invalidate();
      setTarget(null);
      onDone(target === "ACTIVE" ? `${name} is active again and joins the next run.` : target === "SUSPENDED" ? `${name} is suspended and left out of new runs.` : `${name} is terminated as of ${formatDate(date)}.`);
    } catch (failure) {
      setError(message(failure, "The status could not be changed. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  if (employee.status === "TERMINATED") {
    return <p className="text-sm text-muted-foreground">Termination is final. To take {name} back on, add them as a new employee.</p>;
  }
  if (target === null) {
    return (
      <div className="flex flex-col gap-2 sm:flex-row">
        {employee.status === "SUSPENDED" ? (
          <Button type="button" variant="outline" className="h-11" onClick={() => setTarget("ACTIVE")}>
            Reinstate
          </Button>
        ) : null}
        {employee.status === "ACTIVE" ? (
          <Button type="button" variant="outline" className="h-11" onClick={() => setTarget("SUSPENDED")}>
            Suspend
          </Button>
        ) : null}
        <Button type="button" variant="outline" className="h-11" onClick={() => setTarget("TERMINATED")}>
          Terminate
        </Button>
      </div>
    );
  }
  const words =
    target === "ACTIVE"
      ? { ask: `Reinstate ${name}?`, detail: "They are included in the next payroll run.", yes: "Yes, reinstate" }
      : target === "SUSPENDED"
        ? { ask: `Suspend ${name}?`, detail: "They are left out of new payroll runs until reinstated. Their record and payslips stay.", yes: "Yes, suspend" }
        : { ask: `Terminate ${name}?`, detail: "They are left out of new payroll runs, and it is final — taking them back on means adding them as a new employee. Nothing is deleted: their payslips are what a P9 is built from.", yes: "Yes, terminate" };
  return (
    <div role="alertdialog" aria-labelledby={ids.title} className="space-y-2 rounded-md border p-3 text-sm">
      <p id={ids.title} className="font-medium">
        {words.ask}
      </p>
      <p>{words.detail}</p>
      {target === "TERMINATED" ? <TextField id={ids.date} label="Last day" type="date" value={date} error={problem ?? undefined} onChange={(e) => setDate(e.target.value)} /> : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={() => setTarget(null)} disabled={saving} data-autofocus>
          Back
        </Button>
        <Button type="button" className="h-11" variant={target === "ACTIVE" ? "default" : "destructive"} onClick={() => void confirm()} disabled={saving}>
          {saving ? "Saving…" : words.yes}
        </Button>
      </div>
    </div>
  );
}

function EmployeeDetail({ employeeId, permissions }: { employeeId: string; permissions: PayrollPermissions }) {
  const employee = useEmployee(employeeId);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (employee.isPending) return <LoadingState label="Loading the employee" lines={5} />;
  if (employee.isError) return <ErrorState title="Couldn’t load the employee" description={employee.error.message} onRetry={() => void employee.refetch()} />;
  const e = employee.data;
  if (editing)
    return (
      <EmployeeForm
        employee={e}
        onCancel={() => setEditing(false)}
        onDone={(_, note) => {
          setEditing(false);
          setNotice(note);
        }}
      />
    );
  const facts: Array<[string, string | null]> = [
    ["Employee number", e.employeeNumber.toString()],
    ["Status", `${EMPLOYEE_STATUS_LABEL[e.status]}${e.terminationDate ? ` — last day ${formatDate(e.terminationDate)}` : ""}`],
    ["Employment type", EMPLOYMENT_TYPE_LABEL[e.employmentType]],
    ["Started", formatDate(e.hireDate)],
    ["Basic pay", kes(e.basicSalary)],
    ["Gross monthly", kes(e.grossMonthly)],
    ["National ID", e.nationalId],
    ["KRA PIN", e.kraPin],
    ["NSSF number", e.nssfNumber],
    ["SHIF number", e.shifNumber],
    ["Paid by", PAY_METHOD_LABEL[e.paymentMethod]],
    [e.paymentMethod === "MPESA" ? "M-Pesa number" : "Bank account", e.paymentMethod === "BANK" ? [e.bankName, e.bankAccount].filter(Boolean).join(" · ") || null : e.paymentMethod === "MPESA" ? e.bankAccount : "—"],
  ];
  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      <dl className="text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={value ? "text-right" : "text-right text-muted-foreground"}>{value ?? "Not recorded"}</dd>
          </div>
        ))}
      </dl>
      <table className="w-full text-sm">
        <caption className="pb-1 text-left font-medium">Allowances</caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-1 font-normal">
              Allowance
            </th>
            <th scope="col" className="py-1 font-normal">
              Taxable
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              Monthly
            </th>
          </tr>
        </thead>
        <tbody>
          {e.allowances.length === 0 ? (
            <tr>
              <td colSpan={3} className="py-1 text-muted-foreground">
                None
              </td>
            </tr>
          ) : (
            e.allowances.map((a) => (
              <tr key={a.id} className="border-b last:border-b-0">
                <th scope="row" className="py-1 text-left font-normal">
                  {a.name}
                </th>
                <td className="py-1">{a.taxable ? "Yes" : "No"}</td>
                <td className="py-1 text-right tabular-nums">{kes(a.amount)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {permissions.canHr ? (
        <div className="space-y-2">
          <Button type="button" className="h-11" onClick={() => setEditing(true)}>
            Edit terms
          </Button>
          <StatusChange employee={e} onDone={setNotice} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">HR keeps the employee records — the owner, a manager or the HR officer.</p>
      )}
    </div>
  );
}

export function EmployeesView({ permissions }: { permissions: PayrollPermissions }) {
  const statusId = useId();
  const [status, setStatus] = useState<EmployeeStatus | "">("");
  const employees = useEmployees(status);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="sm:w-56">
          <SelectField id={statusId} label="Status" value={status} onChange={(v) => setStatus(v as EmployeeStatus | "")}>
            <option value="">Everyone</option>
            {(Object.keys(EMPLOYEE_STATUS_LABEL) as EmployeeStatus[]).map((s) => (
              <option key={s} value={s}>
                {EMPLOYEE_STATUS_LABEL[s]}
              </option>
            ))}
          </SelectField>
        </div>
        {permissions.canHr ? (
          <Button type="button" className="h-11" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden /> Add employee
          </Button>
        ) : null}
      </div>
      {employees.isPending ? <LoadingState label="Loading employees" lines={4} /> : null}
      {employees.isError ? <ErrorState title="Couldn’t load the employees" description={employees.error.message} onRetry={() => void employees.refetch()} /> : null}
      {employees.isSuccess && employees.data.data.length === 0 ? (
        <EmptyState title={status ? "No one matches" : "No employees yet"} description={status ? "Try another status." : permissions.canHr ? "Add the first employee to start running payroll." : "HR adds employees here."} />
      ) : null}
      {employees.isSuccess && employees.data.data.length > 0 ? (
        <>
          <p className="text-sm text-muted-foreground">
            {employees.data.count.toString()} {employees.data.count === 1 ? "person" : "people"} · gross monthly {kes(employees.data.totalGrossMonthly)}
          </p>
          <ul aria-label="Employees" className="space-y-2">
            {employees.data.data.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => setOpen(e.id)}
                  className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>
                    <span className="font-medium">
                      {e.firstName} {e.lastName}
                    </span>{" "}
                    <span className="text-muted-foreground">· #{e.employeeNumber.toString()}</span>
                    <span className="block text-xs text-muted-foreground">
                      {EMPLOYMENT_TYPE_LABEL[e.employmentType]} · {PAY_METHOD_LABEL[e.paymentMethod]} · {kes(e.grossMonthly)} a month
                    </span>
                  </span>
                  <EmployeeStatusBadge status={e.status} />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {open ? (
        <Sheet key={open} title="Employee" onClose={() => setOpen(null)} wide>
          <EmployeeDetail employeeId={open} permissions={permissions} />
        </Sheet>
      ) : null}
      {adding ? (
        <Sheet title="Add an employee" onClose={() => setAdding(false)} wide>
          <EmployeeForm
            employee={null}
            onCancel={() => setAdding(false)}
            onDone={(_, note) => {
              setAdding(false);
              setNotice(note);
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}
