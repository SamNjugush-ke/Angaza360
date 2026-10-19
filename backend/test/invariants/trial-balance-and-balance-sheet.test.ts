// ===========================================================================
// INVARIANTS: the trial balance balances, and the balance sheet satisfies
// Assets = Liabilities + Equity (the engineering ledger "Financial Reporting").
//
// Activity is posted through the real services first, so the identities are checked
// over a ledger with revenue, VAT, cost of sales, an expense and owner capital in it.
// Each identity is checked twice: as the reports service states it, AND against
// independent SQL over journal_lines — so a report that asserted `balances: true`
// over the wrong figures would still fail here.
// ===========================================================================

import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { businessToday } from "../../src/lib/business-time";
import { getTrialBalance, postJournalEntry } from "../../src/services/ledger";
import { buildBalanceSheet, buildTrialBalance, type ReportSource } from "../../src/services/reports";
import { recordSale } from "../../src/services/sales";
import { schemaOf, tenantDb } from "../setup/tenant";
import { actorId, createProduct, createSupplier, openTill, receiveStock } from "../support/fixtures";

const schema = schemaOf();
// Far enough out to include every posted entry, including future-dated payroll accruals.
const END_OF_TIME = new Date(Date.UTC(9999, 11, 31));

function source(): ReportSource {
  return { reader: tenantDb(), schema };
}

/** Independent: Σ(debit − credit) per account class over every posted line. */
async function netByClass(): Promise<Map<string, bigint>> {
  const result = await pool.query<{ accountClass: string; net: string }>(
    `SELECT a."accountClass"::text AS "accountClass", COALESCE(SUM(l."debit" - l."credit"), 0)::text AS net
       FROM "${schema}".journal_lines l JOIN "${schema}".accounts a ON a."id" = l."accountId"
      GROUP BY a."accountClass"`,
  );
  return new Map(result.rows.map((row) => [row.accountClass, BigInt(row.net)]));
}

beforeAll(async () => {
  const db = tenantDb();
  await postJournalEntry(db, {
    entryDate: new Date(),
    description: "T-A1 capital injection",
    source: "MANUAL",
    createdBy: actorId(),
    lines: [
      { accountCode: "1020", debit: 10000000n },
      { accountCode: "3000", credit: 10000000n },
    ],
  });
  await postJournalEntry(db, {
    entryDate: new Date(),
    description: "T-A1 rent",
    source: "EXPENSE",
    createdBy: actorId(),
    lines: [
      { accountCode: "6000", debit: 1500000n },
      { accountCode: "1020", credit: 1500000n },
    ],
  });
  const supplierId = await createSupplier(db);
  const productId = await createProduct(db, { price: 100000n, taxClass: "ZERO_RATED" });
  await receiveStock(db, supplierId, [{ productId, quantity: "4", unitCost: 60000n }]);
  const till = await openTill(db);
  await recordSale(db, {
    shiftId: till.shiftId,
    createdBy: till.cashierId,
    lines: [{ productId, quantity: "2" }],
    tenders: [{ tenderType: "CASH", amount: "2000.00" }],
  });
});

describe("trial balance", () => {
  it("Σ debits == Σ credits across all accounts (ledger service)", async () => {
    const rows = await getTrialBalance(tenantDb(), END_OF_TIME);
    expect(rows.length).toBeGreaterThan(0);
    const debits = rows.reduce((sum, row) => sum + row.totalDebit, 0n);
    const credits = rows.reduce((sum, row) => sum + row.totalCredit, 0n);
    expect(debits).toBeGreaterThan(0n);
    expect(debits).toBe(credits);
  });

  it("the ledger's totals equal an independent sum over journal_lines", async () => {
    const rows = await getTrialBalance(tenantDb(), END_OF_TIME);
    const independent = await pool.query<{ d: string; c: string }>(
      `SELECT COALESCE(SUM("debit"), 0)::text AS d, COALESCE(SUM("credit"), 0)::text AS c FROM "${schema}".journal_lines`,
    );
    expect(rows.reduce((sum, row) => sum + row.totalDebit, 0n)).toBe(BigInt(independent.rows[0]?.d ?? "-1"));
    expect(rows.reduce((sum, row) => sum + row.totalCredit, 0n)).toBe(BigInt(independent.rows[0]?.c ?? "-1"));
  });

  it("the Module 13 trial balance report balances on its presented columns", async () => {
    const report = await buildTrialBalance(source(), END_OF_TIME, false);
    expect(report.totals.debit).toBe(report.totals.credit);
    expect(report.rows.every((row) => row.debit === 0n || row.credit === 0n)).toBe(true);
  });
});

describe("balance-sheet identity", () => {
  it.each([
    ["today", () => businessToday()],
    ["every posted entry", () => END_OF_TIME],
  ])("Assets = Liabilities + Equity as at %s (reports service)", async (_label, asOf) => {
    const sheet = await buildBalanceSheet(source(), asOf(), true);
    // Not trivially empty. (The SIGN of total assets depends on what other files have
    // posted to the shared fixture — payroll and supplier payments overdraw the bank —
    // so only the identity is asserted, never a sign.)
    expect(sheet.assets.current.lines.length).toBeGreaterThan(0);
    expect(sheet.assets.total.amount).toBe(sheet.liabilitiesAndEquity.amount);
    expect(sheet.liabilities.total.amount + sheet.equity.total).toBe(sheet.liabilitiesAndEquity.amount);
    expect(sheet.assets.total.comparativeAmount).toBe(sheet.liabilitiesAndEquity.comparativeAmount);
  });

  it("the balance sheet's assets equal the independent net of every ASSET account, and the identity holds in raw SQL", async () => {
    const sheet = await buildBalanceSheet(source(), END_OF_TIME, false);
    const byClass = await netByClass();
    const assets = byClass.get("ASSET") ?? 0n;
    expect(sheet.assets.total.amount).toBe(assets);
    // Assets = Liabilities + Equity + accumulated profit, i.e. every class nets to zero.
    let all = 0n;
    for (const net of byClass.values()) all += net;
    expect(all).toBe(0n);
    const liabilities = -(byClass.get("LIABILITY") ?? 0n);
    const equityAndProfit =
      -(byClass.get("EQUITY") ?? 0n) -
      (byClass.get("REVENUE") ?? 0n) -
      (byClass.get("COST_OF_SALES") ?? 0n) -
      (byClass.get("EXPENSE") ?? 0n);
    expect(assets).toBe(liabilities + equityAndProfit);
    expect(sheet.liabilities.total.amount).toBe(liabilities);
    expect(sheet.equity.total).toBe(equityAndProfit);
  });
});
