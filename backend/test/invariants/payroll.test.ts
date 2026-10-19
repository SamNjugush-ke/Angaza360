// ===========================================================================
// INVARIANTS: payroll reconciles and a fully settled run ZEROES its liabilities
// (the engineering ledger "Payroll", Tasks 8.1 + 8.2).
//
// A run is driven end to end through the REAL services — create (DRAFT) -> approve ->
// post (the accrual) -> settle net pay -> remit all four statutory heads in full —
// and then checked:
//   * every payslip: gross = net + Σ deductions, deductions = NSSF + SHIF + AHL + PAYE;
//   * the worked example from the engineering ledger to the cent (gross 100,000.00 -> net 70,441.65);
//   * the accrual and every settlement entry balance;
//   * 2120, 2200, 2210, 2220, 2230 net to EXACTLY ZERO for the run, and the cash paid
//     out equals Σ gross + Σ employer contributions.
// Then the fail-closed CHECK `payroll_run_status_fields_coherent` (migration 0022) is
// attacked directly with raw SQL.
// ===========================================================================

import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import {
  approvePayrollRun,
  createEmployee,
  createPayrollRun,
  postPayrollRun,
  type PayrollRunDetail,
} from "../../src/services/payroll";
import {
  recordStatutoryRemittance,
  runHeadPositions,
  settleNetPay,
} from "../../src/services/payroll-settlement";
import { FIXTURE_SUBDOMAIN, schemaOf, tenantDb, withTenantTx } from "../setup/tenant";
import { actorId, entryNet } from "../support/fixtures";
import { expectDbRefusal } from "../support/db-errors";

const schema = schemaOf();
const LIABILITIES = ["2120", "2200", "2210", "2220", "2230"] as const;
const CASH = ["1000", "1010", "1020"] as const;
let run: PayrollRunDetail;
let settlementEntries: string[] = [];

beforeAll(async () => {
  const db = tenantDb();
  // The worked example from the engineering ledger: basic 80,000 + house 20,000 (taxable) = gross 100,000.
  await createEmployee(db, {
    firstName: "Worked",
    lastName: "Example",
    hireDate: new Date(Date.UTC(2025, 0, 6)),
    basicSalary: 8000000n,
    allowances: [{ name: "House", amount: 2000000n, taxable: true }],
  });
  // The SHIF-minimum edge: gross 8,000 pays the 300.00 floor and no PAYE.
  await createEmployee(db, {
    firstName: "Low",
    lastName: "Earner",
    hireDate: new Date(Date.UTC(2025, 0, 6)),
    basicSalary: 800000n,
  });

  const officer = actorId();
  const draft = await createPayrollRun(db, {
    periodYear: 2026,
    periodMonth: 9,
    payDate: new Date(Date.UTC(2026, 8, 30)),
    createdById: officer,
  });
  await approvePayrollRun(db, draft.id, actorId());
  run = await postPayrollRun(db, draft.id, actorId());

  const settlement = await settleNetPay(db, run.id, {
    paymentDate: new Date(Date.UTC(2026, 8, 30)),
    method: "BANK",
    createdById: actorId(),
  });
  const positions = await runHeadPositions(db, run);
  const remittanceIds: string[] = [];
  for (const position of Object.values(positions)) {
    const outstanding = position.outstanding ?? 0n;
    if (outstanding > 0n) {
      const remittance = await recordStatutoryRemittance(db, {
        statutoryType: position.statutoryType,
        amount: outstanding,
        remittanceDate: new Date(Date.UTC(2026, 9, 9)),
        method: "BANK",
        payrollRunId: run.id,
        createdById: actorId(),
      });
      remittanceIds.push(remittance.id);
    }
  }
  const entries = await pool.query<{ journalEntryId: string }>(
    `SELECT "journalEntryId" FROM "${schema}".net_pay_payments WHERE "id" = $1
     UNION ALL
     SELECT "journalEntryId" FROM "${schema}".statutory_remittances WHERE "id" = ANY($2::text[])`,
    [settlement.id, remittanceIds],
  );
  settlementEntries = entries.rows.map((row) => row.journalEntryId);
});

describe("payroll reconciles", () => {
  it("every payslip: gross = net + Σ deductions, and deductions = NSSF + SHIF + AHL + PAYE", () => {
    expect(run.payslips).toHaveLength(2);
    for (const slip of run.payslips) {
      expect(slip.grossPay).toBe(slip.netPay + slip.totalEmployeeDeductions);
      expect(slip.totalEmployeeDeductions).toBe(slip.nssfEmployee + slip.shifEmployee + slip.ahlEmployee + slip.paye);
      expect(slip.nssfTier1 + slip.nssfTier2).toBe(slip.nssfEmployee);
    }
  });

  it("reproduces the worked example from the engineering ledger to the cent", () => {
    const worked = run.payslips.find((slip) => slip.grossPay === 10000000n);
    expect(worked).toMatchObject({
      nssfEmployee: 600000n,
      shifEmployee: 275000n,
      ahlEmployee: 150000n,
      taxablePay: 8975000n,
      payeBeforeRelief: 2170835n,
      paye: 1930835n,
      netPay: 7044165n,
    });
    const low = run.payslips.find((slip) => slip.grossPay === 800000n);
    expect(low).toMatchObject({ shifEmployee: 30000n, paye: 0n });
  });

  it("the accrual and every settlement entry balance, and the accrual debits only 6020/6025", async () => {
    if (run.journalEntryId === null) throw new Error("posted run has no accrual entry");
    for (const entryId of [run.journalEntryId, ...settlementEntries]) {
      const sums = await pool.query<{ d: string; c: string }>(
        `SELECT SUM("debit")::text AS d, SUM("credit")::text AS c FROM "${schema}".journal_lines WHERE "entryId" = $1`,
        [entryId],
      );
      expect(sums.rows[0]?.d).toBe(sums.rows[0]?.c);
    }
    const gross = run.payslips.reduce((sum, slip) => sum + slip.grossPay, 0n);
    const employer = run.payslips.reduce((sum, slip) => sum + slip.nssfEmployer + slip.ahlEmployer, 0n);
    expect(await entryNet(schema, run.journalEntryId, "6020")).toBe(gross);
    expect(await entryNet(schema, run.journalEntryId, "6025")).toBe(employer);
  });

  it("a fully settled run nets all FIVE payroll liabilities to exactly zero", async () => {
    const entries = [run.journalEntryId ?? "", ...settlementEntries];
    expect(settlementEntries.length).toBe(5); // net pay + four heads
    for (const code of LIABILITIES) {
      let net = 0n;
      for (const entryId of entries) net += await entryNet(schema, entryId, code);
      expect(net, `liability ${code} for the run`).toBe(0n);
    }
  });

  it("the cash paid out equals Σ gross + Σ employer contributions (the accrual's debit side)", async () => {
    let cashOut = 0n;
    for (const entryId of settlementEntries) {
      for (const code of CASH) cashOut -= await entryNet(schema, entryId, code);
    }
    const gross = run.payslips.reduce((sum, slip) => sum + slip.grossPay, 0n);
    const employer = run.payslips.reduce((sum, slip) => sum + slip.nssfEmployer + slip.ahlEmployer, 0n);
    expect(cashOut).toBe(gross + employer);
    const status = await pool.query<{ status: string }>(
      `SELECT "status"::text AS status FROM "${schema}".payroll_runs WHERE "id" = $1`,
      [run.id],
    );
    expect(status.rows[0]?.status).toBe("PAID");
  });
});

describe("payroll_run_status_fields_coherent (fail-closed CHECK, migration 0022)", () => {
  it("the run guard trigger refuses an incoherent PAID row first (PAID is terminal)", async () => {
    await expectDbRefusal(
      withTenantTx(FIXTURE_SUBDOMAIN, (client) =>
        client.query(`UPDATE "${schema}".payroll_runs SET "journalEntryId" = NULL WHERE "id" = $1`, [run.id]),
      ),
      { fn: "payroll_run_guard" },
    );
  });

  it("the CHECK refuses a PAID row with no accrual entry EVEN WITH EVERY TRIGGER SUSPENDED", async () => {
    // session_replication_role = replica suspends ordinary triggers for this rolled-back
    // transaction only, leaving CHECK constraints in force — so what refuses here can
    // only be the CHECK itself.
    for (const assignment of [`"journalEntryId" = NULL`, `"postedAt" = NULL`, `"approvedById" = NULL`]) {
      await expectDbRefusal(
        withTenantTx(FIXTURE_SUBDOMAIN, async (client) => {
          await client.query("SET LOCAL session_replication_role = replica");
          await client.query(`UPDATE "${schema}".payroll_runs SET ${assignment} WHERE "id" = $1`, [run.id]);
        }),
        { constraint: "payroll_run_status_fields_coherent", code: "23514" },
      );
    }
  });

  it("control: a coherent change under the same suspension is accepted (so the refusal above is the CHECK)", async () => {
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      const updated = await client.query(`UPDATE "${schema}".payroll_runs SET "notes" = 'control' WHERE "id" = $1`, [
        run.id,
      ]);
      expect(updated.rowCount).toBe(1);
    });
  });
});
