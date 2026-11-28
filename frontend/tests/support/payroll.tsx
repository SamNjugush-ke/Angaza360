import { render } from "@testing-library/react";
import { vi } from "vitest";
import { Payroll } from "@/components/payroll/payroll";
import { DataProvider } from "@/components/providers/data-provider";
import { LocationProvider } from "@/components/shell/location";
import { ToastProvider } from "@/components/toast/toast";
import type { Role } from "@/lib/auth/landing";
import { cents, json, refusal, type Call } from "./money";

// A fake /v1/payroll server for the Payroll tests. Its payslips are the KE-2026-02 ruleset's own
// answers (the the engineering ledger worked example: gross 100,000 → NSSF 6,000, SHIF 2,750, housing levy
// 1,500, PAYE 19,308.35, net 70,441.65; and gross 30,000 worked the same way), so a test can check
// the screen shows the server's figures. It enforces the run lifecycle (DRAFT → APPROVED → POSTED
// → PAID; cancel only before posting; one live run a month), the net settlement, remittances that
// may not exceed what is owed, and refuses any money that is not a shilling string ("70441.65").

type Slip = Record<string, string | number | object>;
interface Emp {
  id: string;
  employeeNumber: number;
  firstName: string;
  lastName: string;
  nationalId: string | null;
  kraPin: string | null;
  nssfNumber: string | null;
  shifNumber: string | null;
  employmentType: string;
  status: string;
  hireDate: string;
  terminationDate: string | null;
  basicSalary: string;
  paymentMethod: string;
  bankName: string | null;
  bankAccount: string | null;
  allowances: Array<{ id: string; name: string; amount: string; taxable: boolean }>;
}
interface RunRow {
  id: string;
  runNumber: number;
  periodYear: number;
  periodMonth: number;
  status: string;
  payDate: string;
  notes: string | null;
  payslips: Slip[];
}

export interface PayrollServer {
  calls: Call[];
  routes: Array<(call: Call) => Response | null>;
  employees: Emp[];
  runs: RunRow[];
  net: Record<string, Record<string, unknown>>;
  remittances: Array<Record<string, unknown>>;
  /** A run for this month already at the given status, with every active employee's payslip. */
  seedRun: (status: string) => void;
}

/** gross (cents) → the KE-2026-02 deductions, in cents. */
const ENGINE: Record<string, { nssf: string; shif: string; ahl: string; taxable: string; before: string; relief: string; paye: string; ded: string; net: string }> = {
  "10000000": { nssf: "600000", shif: "275000", ahl: "150000", taxable: "8975000", before: "2170835", relief: "240000", paye: "1930835", ded: "2955835", net: "7044165" },
  "3000000": { nssf: "180000", shif: "82500", ahl: "45000", taxable: "2692500", before: "313125", relief: "240000", paye: "73125", ded: "380625", net: "2619375" },
};

const add = (...xs: string[]) => xs.reduce((s, x) => s + BigInt(x), 0n).toString();

export function installPayrollServer(): PayrollServer {
  const employees: Emp[] = [
    { id: "e-1", employeeNumber: 1, firstName: "Wanjiku", lastName: "Mwangi", nationalId: "12345678", kraPin: "A012345678Z", nssfNumber: "NSSF-1", shifNumber: "SHIF-1", employmentType: "PERMANENT", status: "ACTIVE", hireDate: "2026-01-05T00:00:00.000Z", terminationDate: null, basicSalary: "8000000", paymentMethod: "BANK", bankName: "KCB", bankAccount: "1100223344", allowances: [{ id: "al-1", name: "House", amount: "2000000", taxable: true }] },
    { id: "e-2", employeeNumber: 2, firstName: "Otieno", lastName: "Kamau", nationalId: null, kraPin: null, nssfNumber: "NSSF-2", shifNumber: "SHIF-2", employmentType: "CASUAL", status: "ACTIVE", hireDate: "2026-03-01T00:00:00.000Z", terminationDate: null, basicSalary: "3000000", paymentMethod: "MPESA", bankName: null, bankAccount: "0712345678", allowances: [] },
  ];
  const server: PayrollServer = { calls: [], routes: [], employees, runs: [], net: {}, remittances: [], seedRun: () => undefined };
  const grossOf = (e: Emp) => add(e.basicSalary, ...e.allowances.map((a) => a.amount));
  const employeeView = (e: Emp) => ({ ...e, grossMonthly: grossOf(e), createdAt: "2026-01-05T00:00:00.000Z", updatedAt: "2026-01-05T00:00:00.000Z" });
  const slipFor = (runId: string, e: Emp): Slip => {
    const gross = grossOf(e);
    const m = ENGINE[gross] ?? { nssf: "0", shif: "30000", ahl: "0", taxable: gross, before: "0", relief: "0", paye: "0", ded: "30000", net: (BigInt(gross) - 30000n).toString() };
    return {
      id: `ps-${runId}-${e.id}`,
      payrollRunId: runId,
      employeeId: e.id,
      employeeNumber: e.employeeNumber,
      employeeName: `${e.firstName} ${e.lastName}`,
      grossPay: gross,
      taxableGross: gross,
      nssfEmployee: m.nssf,
      nssfEmployer: m.nssf,
      nssfTier1: (BigInt(m.nssf) > 54000n ? 54000n : BigInt(m.nssf)).toString(),
      nssfTier2: (BigInt(m.nssf) > 54000n ? BigInt(m.nssf) - 54000n : 0n).toString(),
      shifEmployee: m.shif,
      ahlEmployee: m.ahl,
      ahlEmployer: m.ahl,
      taxablePay: m.taxable,
      payeBeforeRelief: m.before,
      personalReliefApplied: m.relief,
      paye: m.paye,
      totalEmployeeDeductions: m.ded,
      netPay: m.net,
      createdAt: "2026-11-10T08:00:00.000Z",
      earnings: [{ name: "Basic salary", amount: e.basicSalary, taxable: true }, ...e.allowances.map((a) => ({ name: a.name, amount: a.amount, taxable: a.taxable }))],
    };
  };
  const sum = (run: RunRow, key: string) => add(...run.payslips.map((p) => String(p[key])), "0");
  const runView = (run: RunRow) => ({
    id: run.id,
    runNumber: run.runNumber,
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    status: run.status,
    payDate: `${run.payDate}T00:00:00.000Z`,
    statutoryScheduleId: "sch-1",
    statutoryScheduleLabel: "KE-2026-02",
    journalEntryId: ["POSTED", "PAID"].includes(run.status) ? `je-${run.id}` : null,
    createdById: "u-owner",
    approvedById: run.status === "DRAFT" ? null : "u-owner",
    postedAt: ["POSTED", "PAID"].includes(run.status) ? "2026-11-10T09:00:00.000Z" : null,
    notes: run.notes,
    createdAt: "2026-11-10T08:00:00.000Z",
    updatedAt: "2026-11-10T08:00:00.000Z",
    totals: { grossPay: sum(run, "grossPay"), paye: sum(run, "paye"), shifTotal: sum(run, "shifEmployee"), netPay: sum(run, "netPay"), employeeCount: run.payslips.length },
    payslips: run.payslips,
  });
  const posted = (run: RunRow) => run.status === "POSTED" || run.status === "PAID";
  const headTotal = (run: RunRow, head: string) =>
    head === "PAYE" ? sum(run, "paye") : head === "NSSF" ? add(sum(run, "nssfEmployee"), sum(run, "nssfEmployer")) : head === "SHIF" ? sum(run, "shifEmployee") : add(sum(run, "ahlEmployee"), sum(run, "ahlEmployer"));
  const remitted = (run: RunRow, head: string) => add("0", ...server.remittances.filter((r) => r.payrollRunId === run.id && r.statutoryType === head).map((r) => String(r.amount)));
  const tie = (run: RunRow, head: string, authority: string, code: string, field: "kraPin" | "nssfNumber" | "shifNumber") => {
    const total = headTotal(run, head);
    const missing = run.payslips
      .map((p) => employees.find((e) => e.id === p.employeeId))
      .filter((e): e is Emp => e !== undefined && e[field] === null)
      .map((e) => ({ employeeId: e.id, employeeNumber: e.employeeNumber, employeeName: `${e.firstName} ${e.lastName}`, field }));
    return { authority, accountCode: code, total, payslipTotal: total, glCredited: posted(run) ? total : null, remitted: remitted(run, head), outstanding: posted(run) ? (BigInt(total) - BigInt(remitted(run, head))).toString() : null, reconciles: posted(run), missingIdentifiers: missing };
  };
  const header = (run: RunRow) => ({ id: run.id, runNumber: run.runNumber, periodYear: run.periodYear, periodMonth: run.periodMonth, status: run.status, payDate: `${run.payDate}T00:00:00.000Z` });
  const ref = (p: Slip) => ({ employeeId: p.employeeId, employeeNumber: p.employeeNumber, employeeName: p.employeeName });
  const empOf = (p: Slip) => employees.find((e) => e.id === p.employeeId);

  const answer = (call: Call): Response | null => {
    const path = call.url.pathname;
    const body = (call.body ?? {}) as Record<string, unknown>;
    const q = call.url.searchParams;
    if (path === "/api/v1/locations") return json(200, { data: [] });
    if (path === "/api/v1/payroll/employees" && call.method === "GET") {
      const data = employees.filter((e) => !q.get("status") || e.status === q.get("status")).map(employeeView);
      return json(200, { data, count: data.length, totalGrossMonthly: add("0", ...data.map((e) => e.grossMonthly)) });
    }
    if (path === "/api/v1/payroll/employees" && call.method === "POST") {
      try {
        cents(String(body.basicSalary));
        for (const a of (body.allowances ?? []) as Array<{ amount: string }>) cents(a.amount);
      } catch (error) {
        return refusal(400, (error as Error).message);
      }
      const e: Emp = {
        id: `e-${(employees.length + 1).toString()}`,
        employeeNumber: employees.length + 1,
        firstName: String(body.firstName),
        lastName: String(body.lastName),
        nationalId: (body.nationalId as string | undefined) ?? null,
        kraPin: (body.kraPin as string | undefined) ?? null,
        nssfNumber: (body.nssfNumber as string | undefined) ?? null,
        shifNumber: (body.shifNumber as string | undefined) ?? null,
        employmentType: String(body.employmentType ?? "PERMANENT"),
        status: "ACTIVE",
        hireDate: `${String(body.hireDate)}T00:00:00.000Z`,
        terminationDate: null,
        basicSalary: cents(String(body.basicSalary)).toString(),
        paymentMethod: String(body.paymentMethod ?? "BANK"),
        bankName: (body.bankName as string | undefined) ?? null,
        bankAccount: (body.bankAccount as string | undefined) ?? null,
        allowances: ((body.allowances ?? []) as Array<{ name: string; amount: string; taxable?: boolean }>).map((a, i) => ({ id: `al-n${i.toString()}`, name: a.name, amount: cents(a.amount).toString(), taxable: a.taxable ?? true })),
      };
      employees.push(e);
      return json(201, employeeView(e));
    }
    const emp = /^\/api\/v1\/payroll\/employees\/([^/]+)(\/status)?$/.exec(path);
    if (emp) {
      const e = employees.find((x) => x.id === emp[1]);
      if (!e) return refusal(404, "Unknown employee.");
      if (call.method === "GET") return json(200, employeeView(e));
      if (call.method === "PATCH" && emp[2]) {
        if (e.status === "TERMINATED") return refusal(409, `${e.firstName} ${e.lastName} was terminated, and termination is final. To take them back on, add them as a new employee.`);
        if (body.status === "TERMINATED" && !body.terminationDate) return refusal(400, "A termination needs its date: an employee who has left without a leaving date cannot be filed for.");
        e.status = String(body.status);
        e.terminationDate = body.status === "TERMINATED" ? `${String(body.terminationDate)}T00:00:00.000Z` : null;
        return json(200, employeeView(e));
      }
      if (call.method === "PATCH") {
        try {
          if (body.basicSalary !== undefined) e.basicSalary = cents(String(body.basicSalary)).toString();
          if (body.allowances) e.allowances = (body.allowances as Array<{ name: string; amount: string; taxable?: boolean }>).map((a, i) => ({ id: `al-u${i.toString()}`, name: a.name, amount: cents(a.amount).toString(), taxable: a.taxable ?? true }));
        } catch (error) {
          return refusal(400, (error as Error).message);
        }
        for (const key of ["firstName", "lastName", "nationalId", "kraPin", "nssfNumber", "shifNumber", "employmentType", "paymentMethod", "bankName", "bankAccount"] as const) if (key in body) (e as unknown as Record<string, unknown>)[key] = body[key];
        return json(200, employeeView(e));
      }
    }
    if (path === "/api/v1/payroll/runs" && call.method === "GET") {
      const data = [...server.runs].reverse().filter((r) => !q.get("status") || r.status === q.get("status")).map(runView);
      return json(200, { data, count: data.length });
    }
    if (path === "/api/v1/payroll/runs" && call.method === "POST") {
      if (typeof body.periodYear !== "number" || typeof body.periodMonth !== "number") return refusal(400, "periodYear and periodMonth are numbers.");
      if (server.runs.some((r) => r.periodYear === body.periodYear && r.periodMonth === body.periodMonth && r.status !== "CANCELLED")) return refusal(409, `A payroll run for ${String(body.periodYear)}-${String(body.periodMonth)} already exists.`);
      const run: RunRow = { id: `run-${(server.runs.length + 1).toString()}`, runNumber: server.runs.length + 1, periodYear: body.periodYear, periodMonth: body.periodMonth, status: "DRAFT", payDate: String(body.payDate), notes: (body.notes as string | undefined) ?? null, payslips: [] };
      run.payslips = employees.filter((e) => e.status === "ACTIVE").map((e) => slipFor(run.id, e));
      server.runs.push(run);
      return json(201, runView(run));
    }
    const runPath = /^\/api\/v1\/payroll\/runs\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    if (runPath) {
      const run = server.runs.find((r) => r.id === runPath[1]);
      if (!run) return refusal(404, "Unknown payroll run.");
      const action = runPath[2];
      if (!action && call.method === "GET") return json(200, runView(run));
      if (action === "payslips") return json(200, { data: run.payslips });
      if (action === "recompute" && call.method === "POST") {
        if (run.status !== "DRAFT") return refusal(409, `Payroll run ${run.runNumber.toString()} is ${run.status}; only a DRAFT can be recomputed.`);
        run.payslips = employees.filter((e) => e.status === "ACTIVE").map((e) => slipFor(run.id, e));
        return json(200, runView(run));
      }
      if (action === "approve" && call.method === "POST") {
        if (run.status !== "DRAFT") return refusal(409, `Payroll run ${run.runNumber.toString()} is ${run.status}; only a DRAFT can be approved.`);
        run.status = "APPROVED";
        return json(200, runView(run));
      }
      if (action === "post" && call.method === "POST") {
        if (run.status !== "APPROVED") return refusal(409, `Payroll run ${run.runNumber.toString()} is ${run.status}; only an APPROVED run can be posted.`);
        run.status = "POSTED";
        return json(200, runView(run));
      }
      if (action === "cancel" && call.method === "POST") {
        if (!["DRAFT", "APPROVED"].includes(run.status)) return refusal(409, `Payroll run ${run.runNumber.toString()} is ${run.status}; a posted run cannot be cancelled.`);
        run.status = "CANCELLED";
        run.notes = String(body.reason);
        return json(200, runView(run));
      }
      if (action === "settle-net" && call.method === "POST") {
        if (run.status !== "POSTED") return refusal(409, `Payroll run ${run.runNumber.toString()} is ${run.status}; only a POSTED run's net pay can be settled.`);
        run.status = "PAID";
        server.net[run.id] = {
          id: `np-${run.id}`,
          payrollRunId: run.id,
          runNumber: run.runNumber,
          periodYear: run.periodYear,
          periodMonth: run.periodMonth,
          paymentDate: `${String(body.paymentDate)}T00:00:00.000Z`,
          method: body.method,
          debitAccountCode: "2120",
          creditAccountCode: body.method === "BANK" ? "1020" : body.method === "MPESA" ? "1010" : "1000",
          totalNet: sum(run, "netPay"),
          reference: (body.reference as string | undefined) ?? null,
          notes: null,
          journalEntryId: `je-np-${run.id}`,
          createdById: "u-owner",
          createdAt: "2026-11-10T10:00:00.000Z",
          lines: run.payslips.map((p) => ({ id: `npl-${String(p.id)}`, payslipId: p.id, ...ref(p), amount: p.netPay, method: empOf(p)?.paymentMethod ?? "BANK", bankName: empOf(p)?.bankName ?? null, bankAccount: empOf(p)?.bankAccount ?? null })),
        };
        return json(201, server.net[run.id]);
      }
      if (action === "net-payment") return server.net[run.id] ? json(200, server.net[run.id]) : refusal(404, `Payroll run ${run.runNumber.toString()} has not been settled.`);
      if (action === "statutory-summary") {
        const rows = run.payslips;
        return json(200, {
          employer: { name: "Nakuru Hardware", kraPin: "P051234567X" },
          run: header(run),
          paye: { ...tie(run, "PAYE", "KRA", "2200", "kraPin"), rows: rows.map((p) => ({ ...ref(p), kraPin: empOf(p)?.kraPin ?? null, grossPay: p.grossPay, taxablePay: p.taxablePay, payeBeforeRelief: p.payeBeforeRelief, personalReliefApplied: p.personalReliefApplied, paye: p.paye })), totals: { grossPay: sum(run, "grossPay"), taxablePay: sum(run, "taxablePay"), payeBeforeRelief: sum(run, "payeBeforeRelief"), personalReliefApplied: sum(run, "personalReliefApplied"), paye: sum(run, "paye") } },
          nssf: { ...tie(run, "NSSF", "NSSF", "2210", "nssfNumber"), rows: rows.map((p) => ({ ...ref(p), nssfNumber: empOf(p)?.nssfNumber ?? null, grossPay: p.grossPay, tier1: p.nssfTier1, tier2: p.nssfTier2, employee: p.nssfEmployee, employer: p.nssfEmployer, total: add(String(p.nssfEmployee), String(p.nssfEmployer)) })), totals: { grossPay: sum(run, "grossPay"), tier1: sum(run, "nssfTier1"), tier2: sum(run, "nssfTier2"), employee: sum(run, "nssfEmployee"), employer: sum(run, "nssfEmployer"), total: headTotal(run, "NSSF") } },
          shif: { ...tie(run, "SHIF", "SHA", "2220", "shifNumber"), rows: rows.map((p) => ({ ...ref(p), shifNumber: empOf(p)?.shifNumber ?? null, grossPay: p.grossPay, shif: p.shifEmployee })), totals: { grossPay: sum(run, "grossPay"), shif: sum(run, "shifEmployee") } },
          housingLevy: { ...tie(run, "HOUSING_LEVY", "KRA", "2230", "kraPin"), rows: rows.map((p) => ({ ...ref(p), kraPin: empOf(p)?.kraPin ?? null, grossPay: p.grossPay, employee: p.ahlEmployee, employer: p.ahlEmployer, total: add(String(p.ahlEmployee), String(p.ahlEmployer)) })), totals: { grossPay: sum(run, "grossPay"), employee: sum(run, "ahlEmployee"), employer: sum(run, "ahlEmployer"), total: headTotal(run, "HOUSING_LEVY") } },
          fileable: false,
        });
      }
      if (action === "muster") {
        const amounts = (p: Slip) => ({ grossPay: p.grossPay, taxableGross: p.taxableGross, nssf: p.nssfEmployee, shif: p.shifEmployee, housingLevy: p.ahlEmployee, paye: p.paye, totalDeductions: p.totalEmployeeDeductions, netPay: p.netPay, employerNssf: p.nssfEmployer, employerHousingLevy: p.ahlEmployer });
        return json(200, {
          employer: { name: "Nakuru Hardware", kraPin: "P051234567X" },
          run: header(run),
          rows: run.payslips.map((p) => ({ payslipId: p.id, ...ref(p), ...amounts(p) })),
          totals: { grossPay: sum(run, "grossPay"), taxableGross: sum(run, "taxableGross"), nssf: sum(run, "nssfEmployee"), shif: sum(run, "shifEmployee"), housingLevy: sum(run, "ahlEmployee"), paye: sum(run, "paye"), totalDeductions: sum(run, "totalEmployeeDeductions"), netPay: sum(run, "netPay"), employerNssf: sum(run, "nssfEmployer"), employerHousingLevy: sum(run, "ahlEmployer") },
          employeeCount: run.payslips.length,
          reconciles: true,
        });
      }
    }
    const doc = /^\/api\/v1\/payroll\/payslips\/([^/]+)\/document$/.exec(path);
    if (doc) {
      const run = server.runs.find((r) => r.payslips.some((p) => p.id === doc[1]));
      const p = run?.payslips.find((x) => x.id === doc[1]);
      if (!run || !p) return refusal(404, "Unknown payslip.");
      const e = empOf(p);
      const settled = server.net[run.id];
      return json(200, {
        documentType: "PAYSLIP",
        employer: { name: "Nakuru Hardware", kraPin: "P051234567X" },
        payslipId: p.id,
        run: { ...header(run), statutoryScheduleLabel: "KE-2026-02" },
        employee: { id: p.employeeId, employeeNumber: p.employeeNumber, name: p.employeeName, nationalId: e?.nationalId ?? null, kraPin: e?.kraPin ?? null, nssfNumber: e?.nssfNumber ?? null, shifNumber: e?.shifNumber ?? null },
        earnings: p.earnings,
        grossPay: p.grossPay,
        taxableGross: p.taxableGross,
        deductions: { nssf: p.nssfEmployee, nssfTier1: p.nssfTier1, nssfTier2: p.nssfTier2, shif: p.shifEmployee, housingLevy: p.ahlEmployee, paye: p.paye, total: p.totalEmployeeDeductions },
        tax: { taxablePay: p.taxablePay, payeBeforeRelief: p.payeBeforeRelief, personalReliefApplied: p.personalReliefApplied, paye: p.paye },
        netPay: p.netPay,
        employerContributions: { nssf: p.nssfEmployer, housingLevy: p.ahlEmployer, total: add(String(p.nssfEmployer), String(p.ahlEmployer)) },
        payment: settled ? { status: "PAID", paymentDate: settled.paymentDate, settlementMethod: settled.method, employeeMethod: e?.paymentMethod ?? null, amount: p.netPay } : { status: "UNPAID", paymentDate: null, settlementMethod: null, employeeMethod: null, amount: null },
      });
    }
    const one = /^\/api\/v1\/payroll\/remittances\/([^/]+)$/.exec(path);
    if (one) {
      const r = server.remittances.find((x) => x.id === one[1]);
      return r ? json(200, r) : refusal(404, "Unknown remittance.");
    }
    if (path === "/api/v1/payroll/remittances" && call.method === "GET") {
      const data = server.remittances.filter((r) => (!q.get("statutoryType") || r.statutoryType === q.get("statutoryType")) && (!q.get("payrollRunId") || r.payrollRunId === q.get("payrollRunId")));
      return json(200, { data, count: data.length });
    }
    if (path === "/api/v1/payroll/remittances" && call.method === "POST") {
      let amount: bigint;
      try {
        amount = cents(String(body.amount));
      } catch (error) {
        return refusal(400, (error as Error).message);
      }
      const run = server.runs.find((r) => r.id === body.payrollRunId);
      const head = String(body.statutoryType);
      if (run) {
        const owed = BigInt(headTotal(run, head)) - BigInt(remitted(run, head));
        if (amount > owed) return refusal(400, `Remitting ${amount.toString()} cents of ${head} would exceed what run ${run.runNumber.toString()} accrued and has not yet remitted (${owed.toString()} cents).`);
      }
      const row = {
        id: `rem-${(server.remittances.length + 1).toString()}`,
        statutoryType: head,
        authority: head === "NSSF" ? "NSSF" : head === "SHIF" ? "SHA" : "KRA",
        debitAccountCode: head === "PAYE" ? "2200" : head === "NSSF" ? "2210" : head === "SHIF" ? "2220" : "2230",
        creditAccountCode: body.method === "BANK" ? "1020" : body.method === "MPESA" ? "1010" : "1000",
        amount: amount.toString(),
        remittanceDate: `${String(body.remittanceDate)}T00:00:00.000Z`,
        method: body.method,
        reference: (body.reference as string | undefined) ?? null,
        notes: null,
        payrollRunId: run?.id ?? null,
        payrollRunNumber: run?.runNumber ?? null,
        journalEntryId: "je-rem",
        createdById: "u-owner",
        createdAt: "2026-11-10T11:00:00.000Z",
      };
      server.remittances.push(row);
      return json(201, row);
    }
    return null;
  };

  document.cookie = "ag_csrf=csrf-token; path=/";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? "GET", url: new URL(input, "http://app.test"), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    server.calls.push(call);
    for (const route of server.routes) {
      const routed = route(call);
      if (routed) return routed;
    }
    return answer(call) ?? json(404, { statusCode: 404, error: "Not Found", message: "unrouted" });
  });
  server.seedRun = (status: string) => {
    const run: RunRow = { id: `run-${(server.runs.length + 1).toString()}`, runNumber: server.runs.length + 1, periodYear: 2026, periodMonth: 10, status, payDate: "2026-10-28", notes: null, payslips: [] };
    run.payslips = employees.filter((e) => e.status === "ACTIVE").map((e) => slipFor(run.id, e));
    server.runs.push(run);
  };
  return server;
}

export function showPayroll(role: Role = "MSME_OWNER") {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled={false}>
          <main>
            <Payroll role={role} />
          </main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}
