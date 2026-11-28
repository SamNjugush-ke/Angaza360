// ===========================================================================
// INVARIANT: every journal entry balances, enforced AT THE DATABASE (the engineering ledger
// "Double-Entry Ledger Formatting (Strict)").
//
// The ledger service refuses an unbalanced entry before it reaches the database, so
// the service alone proves nothing about the guarantee. These tests attack from
// OUTSIDE the service with raw SQL and pin the refusal to the deferred constraint
// trigger `journal_balance_check` -> function `assert_entry_balanced()`.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { LedgerValidationError, postJournalEntry } from "../../src/services/ledger";
import { FIXTURE_SUBDOMAIN, schemaOf, tenantDb, withTenantTx } from "../setup/tenant";
import { accountIdOf, actorId } from "../support/fixtures";
import { expectDbRefusal } from "../support/db-errors";

const schema = schemaOf();

/** Insert an entry header directly, bypassing the ledger service. */
async function rawEntry(client: PoolClient): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await client.query(
    `INSERT INTO "${schema}".journal_entries
       ("id", "entryNumber", "entryDate", "periodYear", "periodMonth", "description", "source", "createdBy")
     VALUES ($1, $2, $3::date, $4, $5, 'T-A1 adversarial entry', 'MANUAL', 'qa-adversary')`,
    [id, `QA-${id.slice(0, 12)}`, now.toISOString().slice(0, 10), now.getUTCFullYear(), now.getUTCMonth() + 1],
  );
  return id;
}

async function rawLine(
  client: PoolClient,
  entryId: string,
  lineNumber: number,
  accountId: string,
  side: { debit?: bigint; credit?: bigint },
): Promise<void> {
  await client.query(
    `INSERT INTO "${schema}".journal_lines ("id", "entryId", "lineNumber", "accountId", "debit", "credit")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), entryId, lineNumber, accountId, (side.debit ?? 0n).toString(), (side.credit ?? 0n).toString()],
  );
}

describe("double-entry balance", () => {
  it("the ledger service refuses an unbalanced entry and a single-line entry (ergonomics layer)", async () => {
    const db = tenantDb();
    await expect(
      postJournalEntry(db, {
        entryDate: new Date(),
        description: "unbalanced",
        source: "MANUAL",
        createdBy: actorId(),
        lines: [
          { accountCode: "1000", debit: 10000n },
          { accountCode: "3000", credit: 9999n },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError);
    await expect(
      postJournalEntry(db, {
        entryDate: new Date(),
        description: "one line",
        source: "MANUAL",
        createdBy: actorId(),
        lines: [{ accountCode: "1000", debit: 10000n }],
      }),
    ).rejects.toThrow(/at least two lines/);
  });

  it("the DATABASE refuses an unbalanced entry at COMMIT — assert_entry_balanced()", async () => {
    const cash = await accountIdOf(schema, "1000");
    const capital = await accountIdOf(schema, "3000");
    let entryId = "";
    await expectDbRefusal(
      withTenantTx(
        FIXTURE_SUBDOMAIN,
        async (client) => {
          entryId = await rawEntry(client);
          await rawLine(client, entryId, 1, cash, { debit: 10000n });
          await rawLine(client, entryId, 2, capital, { credit: 9999n });
        },
        "commit", // the trigger is DEFERRED: it fires at COMMIT
      ),
      { fn: "assert_entry_balanced", code: "P0001", message: /is unbalanced: debits 10000 <> credits 9999/ },
    );
    const left = await pool.query(`SELECT 1 FROM "${schema}".journal_entries WHERE "id" = $1`, [entryId]);
    expect(left.rowCount, "the refused entry must have rolled back entirely").toBe(0);
  });

  it("the DATABASE refuses a single-line entry — assert_entry_balanced()", async () => {
    const cash = await accountIdOf(schema, "1000");
    await expectDbRefusal(
      withTenantTx(FIXTURE_SUBDOMAIN, async (client) => {
        const entryId = await rawEntry(client);
        await rawLine(client, entryId, 1, cash, { debit: 500n });
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      { fn: "assert_entry_balanced", code: "P0001", message: /must have at least two lines \(found 1\)/ },
    );
  });

  it("control: the same raw path ACCEPTS a balanced entry (so the refusals above are the trigger, not the harness)", async () => {
    const cash = await accountIdOf(schema, "1000");
    const capital = await accountIdOf(schema, "3000");
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client) => {
      const entryId = await rawEntry(client);
      await rawLine(client, entryId, 1, cash, { debit: 10000n });
      await rawLine(client, entryId, 2, capital, { credit: 10000n });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    }); // rolled back: leaves no trace
  });

  it("the journal_balance_check constraint trigger is bound, deferred, to assert_entry_balanced()", async () => {
    const binding = await pool.query<{ fn: string; deferrable: boolean; deferred: boolean }>(
      `SELECT p.proname AS fn, t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = $1 AND c.relname = 'journal_lines' AND t.tgname = 'journal_balance_check'`,
      [schema],
    );
    expect(binding.rows).toEqual([{ fn: "assert_entry_balanced", deferrable: true, deferred: true }]);
  });

  it("EVERY posted journal entry in the tenant has Σdebit = Σcredit and at least two lines", async () => {
    // Ensure there is at least one real posting to check, through the real service.
    await postJournalEntry(tenantDb(), {
      entryDate: new Date(),
      description: "T-A1 owner capital",
      source: "MANUAL",
      createdBy: actorId(),
      lines: [
        { accountCode: "1000", debit: 5000000n },
        { accountCode: "3000", credit: 5000000n },
      ],
    });
    const result = await pool.query<{ entries: string; unbalanced: string }>(
      `SELECT count(*)::text AS entries,
              count(*) FILTER (WHERE d <> c OR n < 2)::text AS unbalanced
         FROM (SELECT e."id", COALESCE(SUM(l."debit"), 0) d, COALESCE(SUM(l."credit"), 0) c, count(l."id") n
                 FROM "${schema}".journal_entries e
                 LEFT JOIN "${schema}".journal_lines l ON l."entryId" = e."id"
                GROUP BY e."id") per_entry`,
    );
    expect(Number(result.rows[0]?.entries)).toBeGreaterThan(0);
    expect(result.rows[0]?.unbalanced).toBe("0");
  });
});
