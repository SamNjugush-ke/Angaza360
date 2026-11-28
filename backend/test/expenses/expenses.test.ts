// ===========================================================================
// SIMPLE EXPENSE CAPTURE (Task T-A9, tenant migration 0028).
//
// * Each payment method posts its honest contra (CASH 1000, MPESA 1010, BANK 1020) against
//   the chosen expense account, in ONE balanced entry linked one-to-one to the Expense row.
// * The expense raises the expense line of the income statement; the trial balance stays
//   balanced.
// * NO INPUT VAT YET: the API has no VAT path, and `expense_input_vat_deferred` refuses a
//   non-zero figure from raw SQL (binding), with a zero as the control.
// * A cost-of-sales, module-owned (payroll / depreciation / TOT), non-expense or unknown
//   account is refused — by the service and by the category CHECK.
// * A void posts a balanced REVERSING entry; the net effect is zero; the row is otherwise
//   immutable and never deleted (guard).
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { businessToday } from "../../src/lib/business-time";
import { getTrialBalance, postJournalEntry } from "../../src/services/ledger";
import { buildIncomeStatement, resolvePeriod } from "../../src/services/reports";
import { buildServer } from "../../src/server";
import { schemaOf, tenantDb, withTenantTx, FIXTURE_SUBDOMAIN } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { entryAccounts, entryNet, glNet } from "../support/fixtures";
import { accessTokenFor, createFixtureUser, deleteUsers, freshIp, type TestUser } from "../security/http-app";

const schema = schemaOf();
const today = businessToday().toISOString().slice(0, 10);

let app: FastifyInstance;
let owner: TestUser;
let cashier: TestUser;
let token = "";
/** A balanced entry no expense links to — the FK target for raw-SQL expense rows. */
let unlinkedEntryId = "";

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  owner = await createFixtureUser("MSME_OWNER");
  cashier = await createFixtureUser("CASHIER");
  token = await accessTokenFor(app, owner);
  const entry = await postJournalEntry(tenantDb(), {
    entryDate: new Date(),
    description: "T-A9 raw-SQL target",
    source: "MANUAL",
    createdBy: owner.id,
    lines: [
      { accountCode: "6900", debit: 100n },
      { accountCode: "1000", credit: 100n },
    ],
  });
  unlinkedEntryId = entry.id;
});

afterAll(async () => {
  await deleteUsers([owner, cashier]);
  await app.close();
});

interface ExpenseBody {
  id: string;
  journalEntryId: string;
  amountCents: string;
  vatInputCents: string;
  isVoided: boolean;
  voidedByEntryId: string | null;
}

function record(payload: Record<string, unknown>, bearer: string = token) {
  return app.inject({ method: "POST", url: "/v1/expenses", remoteAddress: freshIp(), headers: { authorization: `Bearer ${bearer}` }, payload });
}

async function recordOk(payload: Record<string, unknown>): Promise<ExpenseBody> {
  const response = await record({ expenseDate: today, description: "T-A9 test expense", ...payload });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<ExpenseBody>();
}

async function entryTotals(entryId: string): Promise<{ debit: string; credit: string }> {
  const result = await pool.query<{ debit: string; credit: string }>(
    `SELECT SUM("debit")::text AS debit, SUM("credit")::text AS credit FROM "${schema}".journal_lines WHERE "entryId" = $1`,
    [entryId],
  );
  return result.rows[0] ?? { debit: "?", credit: "!" };
}

describe("each payment method posts its honest contra, balanced", () => {
  it.each([
    ["CASH", "1000"],
    ["MPESA", "1010"],
    ["BANK", "1020"],
  ])("%s credits %s", async (paymentMethod, contra) => {
    const expense = await recordOk({ category: "6050", paymentMethod, amount: "1234.56" });
    expect(expense).toMatchObject({ amountCents: "123456", vatInputCents: "0", isVoided: false });
    expect(await entryAccounts(schema, expense.journalEntryId)).toEqual([contra, "6050"].sort());
    expect(await entryNet(schema, expense.journalEntryId, "6050")).toBe(123456n);
    expect(await entryNet(schema, expense.journalEntryId, contra)).toBe(-123456n);
    const totals = await entryTotals(expense.journalEntryId);
    expect(totals.debit).toBe(totals.credit);
    const entry = await tenantDb().journalEntry.findUniqueOrThrow({ where: { id: expense.journalEntryId } });
    expect(entry).toMatchObject({ source: "EXPENSE", sourceId: expense.id });
  });
});

describe("the expense in the statements", () => {
  it("raises the expense line of the income statement; the trial balance stays balanced", async () => {
    const source = { reader: tenantDb(), schema };
    const period = resolvePeriod({});
    const lineOf = async () => {
      const statement = await buildIncomeStatement(source, period, false);
      return { line: statement.operatingExpenses.lines.find((l) => l.code === "6060")?.amount ?? 0n, total: statement.operatingExpenses.total };
    };
    const before = await lineOf();
    await recordOk({ category: "6060", paymentMethod: "CASH", amount: "750.00" });
    const after = await lineOf();
    expect(after.line - before.line).toBe(75000n);
    expect(after.total - before.total).toBe(75000n);

    const rows = await getTrialBalance(tenantDb(), new Date(Date.UTC(9999, 11, 31)));
    expect(rows.reduce((s, r) => s + r.totalDebit, 0n)).toBe(rows.reduce((s, r) => s + r.totalCredit, 0n));
  });
});

describe("no input VAT on an expense (yet)", () => {
  async function insertExpense(client: import("pg").PoolClient, tenantSchema: string, vatInputCents: number): Promise<void> {
    await client.query(
      `INSERT INTO "${tenantSchema}".expenses ("id", "expenseDate", "category", "description", "paymentMethod", "amountCents", "vatInputCents", "journalEntryId", "createdBy")
       VALUES ($1, CURRENT_DATE, '6000', 'raw', 'CASH', 1000, $2, $3, 'qa')`,
      [randomUUID(), vatInputCents, unlinkedEntryId],
    );
  }

  it("control: a raw expense with zero input VAT is accepted", async () => {
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await insertExpense(client, tenantSchema, 0);
    });
  });

  it("a non-zero input VAT is refused by the CHECK, whoever writes it", async () => {
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await expectDbRefusal(insertExpense(client, tenantSchema, 160), { constraint: "expense_input_vat_deferred", code: "23514" });
    });
  });

  it("the API takes no VAT figure: the expense posts gross and touches no 1400", async () => {
    const vatBefore = await glNet(schema, "1400");
    const expense = await recordOk({ category: "6010", paymentMethod: "BANK", amount: "1160.00", vatInput: "160.00" });
    expect(expense.vatInputCents).toBe("0");
    expect(await entryNet(schema, expense.journalEntryId, "6010")).toBe(116000n);
    expect(await glNet(schema, "1400")).toBe(vatBefore);
  });
});

describe("only an operating-expense account no other module owns", () => {
  it.each([
    ["5000", /not an operating-expense account/],
    ["1200", /not an operating-expense account/],
    ["6110", /written by another module/],
    ["6090", /written by another module/],
    ["6020", /written by another module/],
    ["9999", /no account 9999/],
  ])("category %s is refused (400)", async (category, message) => {
    const response = await record({ expenseDate: today, description: "nope", category, paymentMethod: "CASH", amount: "10.00" });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toMatch(message);
  });

  it("the category CHECK refuses a module-owned account from raw SQL", async () => {
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await expectDbRefusal(
        client.query(
          `INSERT INTO "${tenantSchema}".expenses ("id", "expenseDate", "category", "description", "paymentMethod", "amountCents", "journalEntryId", "createdBy")
           VALUES ($1, CURRENT_DATE, '6110', 'raw', 'CASH', 1000, $2, 'qa')`,
          [randomUUID(), unlinkedEntryId],
        ),
        { constraint: "expense_category_is_operating_expense", code: "23514" },
      );
    });
  });

  it("a cashier may not record an expense", async () => {
    const cashierToken = await accessTokenFor(app, cashier);
    const response = await record({ expenseDate: today, description: "x", category: "6000", paymentMethod: "CASH", amount: "1.00" }, cashierToken);
    expect(response.statusCode).toBe(403);
  });
});

describe("void", () => {
  it("posts a balanced reversing entry; the net effect is zero; a second void is 409", async () => {
    const gl6040Before = await glNet(schema, "6040");
    const gl1010Before = await glNet(schema, "1010");
    const expense = await recordOk({ category: "6040", paymentMethod: "MPESA", amount: "300.00" });
    const voided = await app.inject({
      method: "POST",
      url: `/v1/expenses/${expense.id}/void`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "Entered twice" },
    });
    expect(voided.statusCode).toBe(200);
    const body = voided.json<ExpenseBody>();
    expect(body.isVoided).toBe(true);
    const reversalId = body.voidedByEntryId ?? "";
    expect(await entryNet(schema, reversalId, "6040")).toBe(-30000n);
    const totals = await entryTotals(reversalId);
    expect(totals.debit).toBe(totals.credit);
    expect(await glNet(schema, "6040")).toBe(gl6040Before);
    expect(await glNet(schema, "1010")).toBe(gl1010Before);
    // The original entry is still there, unchanged.
    expect(await entryNet(schema, expense.journalEntryId, "6040")).toBe(30000n);

    const again = await app.inject({ method: "POST", url: `/v1/expenses/${expense.id}/void`, headers: { authorization: `Bearer ${token}` }, payload: { reason: "again" } });
    expect(again.statusCode).toBe(409);
  });

  it("an expense cannot be edited or deleted from raw SQL", async () => {
    const expense = await recordOk({ category: "6070", paymentMethod: "CASH", amount: "50.00" });
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await expectDbRefusal(client.query(`UPDATE "${tenantSchema}".expenses SET "amountCents" = 1 WHERE "id" = $1`, [expense.id]), {
        fn: "expense_guard",
        message: /cannot be edited/,
      });
    });
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await expectDbRefusal(client.query(`DELETE FROM "${tenantSchema}".expenses WHERE "id" = $1`, [expense.id]), {
        fn: "expense_guard",
        message: /cannot be deleted/,
      });
    });
  });
});
