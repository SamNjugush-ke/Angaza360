// ===========================================================================
// INVARIANT: a posted journal entry is immutable; corrections are reversals
// (the engineering ledger "Double-Entry Ledger Formatting" and migration 0003 (d)).
//
// Attacked with raw SQL from outside the ledger service. Each refusal is pinned to
// its trigger function:
//   journal_line_no_change   -> journal_line_no_change()
//   journal_entry_no_update  -> journal_entry_guard_update()
//   journal_entry_no_delete  -> journal_entry_no_delete()
// ===========================================================================

import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { postJournalEntry, reverseJournalEntry } from "../../src/services/ledger";
import { FIXTURE_SUBDOMAIN, schemaOf, tenantDb, withTenantTx } from "../setup/tenant";
import { actorId } from "../support/fixtures";
import { expectDbRefusal } from "../support/db-errors";

const schema = schemaOf();
let entryId = "";
let lineId = "";

async function triggerFunction(table: string, trigger: string): Promise<string | undefined> {
  const result = await pool.query<{ fn: string }>(
    `SELECT p.proname AS fn FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3`,
    [schema, table, trigger],
  );
  return result.rows[0]?.fn;
}

beforeAll(async () => {
  const entry = await postJournalEntry(tenantDb(), {
    entryDate: new Date(),
    description: "T-A1 immutability subject",
    source: "MANUAL",
    createdBy: actorId(),
    lines: [
      { accountCode: "1000", debit: 25000n, memo: "original" },
      { accountCode: "3000", credit: 25000n },
    ],
  });
  entryId = entry.id;
  const first = entry.lines[0];
  if (first === undefined) throw new Error("posted entry has no lines");
  lineId = first.id;
});

describe("journal immutability", () => {
  it("the three immutability triggers are bound to the functions named here", async () => {
    expect(await triggerFunction("journal_lines", "journal_line_no_change")).toBe("journal_line_no_change");
    expect(await triggerFunction("journal_entries", "journal_entry_no_update")).toBe("journal_entry_guard_update");
    expect(await triggerFunction("journal_entries", "journal_entry_no_delete")).toBe("journal_entry_no_delete");
  });

  it("refuses an UPDATE of a posted journal line — journal_line_no_change", async () => {
    await expectDbRefusal(
      withTenantTx(FIXTURE_SUBDOMAIN, (client) =>
        client.query(`UPDATE "${schema}".journal_lines SET "debit" = "debit" + 1 WHERE "id" = $1`, [lineId]),
      ),
      { fn: "journal_line_no_change", message: /write-once and cannot be UPDATE/ },
    );
    await expectDbRefusal(
      withTenantTx(FIXTURE_SUBDOMAIN, (client) =>
        client.query(`UPDATE "${schema}".journal_lines SET "memo" = 'tampered' WHERE "id" = $1`, [lineId]),
      ),
      { fn: "journal_line_no_change" },
    );
  });

  it("refuses a DELETE of a posted journal line — journal_line_no_change", async () => {
    await expectDbRefusal(
      withTenantTx(FIXTURE_SUBDOMAIN, (client) =>
        client.query(`DELETE FROM "${schema}".journal_lines WHERE "id" = $1`, [lineId]),
      ),
      { fn: "journal_line_no_change", message: /cannot be DELETE/ },
    );
  });

  it("refuses a non-reversal UPDATE of a posted entry — journal_entry_no_update", async () => {
    for (const assignment of [
      `"description" = 'rewritten'`,
      `"entryDate" = "entryDate" - 1`,
      `"periodMonth" = CASE WHEN "periodMonth" = 1 THEN 2 ELSE 1 END`,
    ]) {
      await expectDbRefusal(
        withTenantTx(FIXTURE_SUBDOMAIN, (client) =>
          client.query(`UPDATE "${schema}".journal_entries SET ${assignment} WHERE "id" = $1`, [entryId]),
        ),
        { fn: "journal_entry_guard_update", message: /is immutable; only reversal marking is permitted/ },
      );
    }
    // Flipping the status without a reversing entry is not a reversal either.
    await expectDbRefusal(
      withTenantTx(FIXTURE_SUBDOMAIN, (client) =>
        client.query(`UPDATE "${schema}".journal_entries SET "status" = 'REVERSED' WHERE "id" = $1`, [entryId]),
      ),
      { fn: "journal_entry_guard_update", message: /did not set reversedByEntryId/ },
    );
  });

  it("refuses a DELETE of a posted entry — journal_entry_no_delete", async () => {
    await expectDbRefusal(
      withTenantTx(FIXTURE_SUBDOMAIN, (client) =>
        client.query(`DELETE FROM "${schema}".journal_entries WHERE "id" = $1`, [entryId]),
      ),
      { fn: "journal_entry_no_delete", message: /immutable and cannot be deleted/ },
    );
  });

  it("the entry is untouched after every attack", async () => {
    const after = await pool.query<{ description: string; status: string; memo: string; debit: string }>(
      `SELECT e."description", e."status"::text AS status, l."memo", l."debit"::text AS debit
         FROM "${schema}".journal_entries e JOIN "${schema}".journal_lines l ON l."entryId" = e."id"
        WHERE l."id" = $1`,
      [lineId],
    );
    expect(after.rows).toEqual([
      { description: "T-A1 immutability subject", status: "POSTED", memo: "original", debit: "25000" },
    ]);
  });

  it("the ONE permitted mutation — reversal through the ledger — succeeds and leaves the original's figures intact", async () => {
    const reversal = await reverseJournalEntry(tenantDb(), entryId, "T-A1 correction", actorId());
    expect(reversal.reversesEntryId).toBe(entryId);
    const original = await pool.query<{ status: string; reversedByEntryId: string; debit: string }>(
      `SELECT e."status"::text AS status, e."reversedByEntryId", l."debit"::text AS debit
         FROM "${schema}".journal_entries e JOIN "${schema}".journal_lines l ON l."entryId" = e."id"
        WHERE l."id" = $1`,
      [lineId],
    );
    expect(original.rows).toEqual([{ status: "REVERSED", reversedByEntryId: reversal.id, debit: "25000" }]);
    // A second reversal marking is refused by the same guard.
    await expectDbRefusal(
      withTenantTx(FIXTURE_SUBDOMAIN, (client) =>
        client.query(`UPDATE "${schema}".journal_entries SET "reversedByEntryId" = $2 WHERE "id" = $1`, [
          entryId,
          entryId,
        ]),
      ),
      { fn: "journal_entry_guard_update", message: /already reversed/ },
    );
  });
});
