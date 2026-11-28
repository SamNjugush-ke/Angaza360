// ===========================================================================
// INVARIANT (Task T-B-JE-CONTROL-GUARD): a MANUAL journal entry may not touch a subledger control
// account — 1015 M-Pesa Clearing, 1100 AR, 1200 Inventory, 2000 AP, 2050 GRNI.
//
// The ledger service refuses it (400 through POST /v1/ledger/entries); migration 0032's trigger
// `journal_line_manual_control_guard` is the guarantee, attacked here with raw SQL. Controls: a raw
// MANUAL line on an ordinary account, a raw line on a control account under a MODULE source, and a
// raw REVERSAL of a manual entry are all accepted.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { LedgerValidationError, postJournalEntry } from "../../src/services/ledger";
import { SUBLEDGER_CONTROL_ACCOUNTS } from "../../src/services/control-accounts";
import { FIXTURE_SUBDOMAIN, schemaOf, tenantDb, withTenantTx } from "../setup/tenant";
import { accountIdOf, actorId } from "../support/fixtures";
import { expectDbRefusal } from "../support/db-errors";

const schema = schemaOf();
const CONTROLS = ["1015", "1100", "1200", "2000", "2050"] as const;

async function rawEntry(client: PoolClient, source: string, reversesEntryId: string | null = null): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await client.query(
    `INSERT INTO "${schema}".journal_entries
       ("id", "entryNumber", "entryDate", "periodYear", "periodMonth", "description", "source", "createdBy", "reversesEntryId")
     VALUES ($1, $2, $3::date, $4, $5, 'control-guard adversary', $6::"${schema}"."JournalSource", 'qa-adversary', $7)`,
    [id, `QA-${id.slice(0, 12)}`, now.toISOString().slice(0, 10), now.getUTCFullYear(), now.getUTCMonth() + 1, source, reversesEntryId],
  );
  return id;
}

async function rawLine(client: PoolClient, entryId: string, lineNumber: number, code: string, side: { debit?: bigint; credit?: bigint }): Promise<void> {
  await client.query(
    `INSERT INTO "${schema}".journal_lines ("id", "entryId", "lineNumber", "accountId", "debit", "credit") VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), entryId, lineNumber, await accountIdOf(schema, code), (side.debit ?? 0n).toString(), (side.credit ?? 0n).toString()],
  );
}

describe("manual journal entries and control accounts", () => {
  it("the control set is exactly the five subledger control accounts", () => {
    expect(Object.keys(SUBLEDGER_CONTROL_ACCOUNTS).sort()).toEqual([...CONTROLS]);
  });

  it.each(CONTROLS)("the ledger service refuses a manual entry touching %s, naming the account", async (code) => {
    await expect(
      postJournalEntry(tenantDb(), {
        entryDate: new Date(),
        description: `manual ${code}`,
        source: "MANUAL",
        createdBy: actorId(),
        lines: [
          { accountCode: code, debit: 10_000n },
          { accountCode: "3000", credit: 10_000n },
        ],
      }),
    ).rejects.toThrow(new RegExp(`Account ${code} cannot take a manual journal entry`));
  });

  it("refuses it under any source the route accepts, and still posts an ordinary manual entry", async () => {
    await expect(
      postJournalEntry(tenantDb(), {
        entryDate: new Date(),
        description: "an opening balance on inventory",
        source: "OPENING_BALANCE",
        createdBy: actorId(),
        lines: [
          { accountCode: "3000", debit: 5_000n },
          { accountCode: "1200", credit: 5_000n },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError);
    const ok = await postJournalEntry(tenantDb(), {
      entryDate: new Date(),
      description: "bank the takings",
      source: "MANUAL",
      createdBy: actorId(),
      lines: [
        { accountCode: "1020", debit: 7_500n },
        { accountCode: "1000", credit: 7_500n },
      ],
    });
    expect(ok.lines).toHaveLength(2);
  });

  it.each(CONTROLS)("the database refuses a raw MANUAL line on %s — journal_line_manual_control_guard", async (code) => {
    await expectDbRefusal(
      withTenantTx(FIXTURE_SUBDOMAIN, async (client) => {
        const entry = await rawEntry(client, "MANUAL");
        await rawLine(client, entry, 1, code, { debit: 100n });
      }),
      { fn: "journal_line_manual_control_guard", message: /manual_entry_control_account/ },
    );
  });

  it("control: the database accepts a raw MANUAL line on an ordinary account, a MODULE line on a control account, and a manual entry's REVERSAL on one", async () => {
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client) => {
      const manual = await rawEntry(client, "MANUAL");
      await rawLine(client, manual, 1, "1020", { debit: 100n });
      await rawLine(client, manual, 2, "1000", { credit: 100n });
      const module = await rawEntry(client, "PURCHASE");
      await rawLine(client, module, 1, "1200", { debit: 100n });
      await rawLine(client, module, 2, "2000", { credit: 100n });
      const original = await rawEntry(client, "MANUAL");
      const reversal = await rawEntry(client, "MANUAL", original);
      await rawLine(client, reversal, 1, "1200", { credit: 100n });
      await rawLine(client, reversal, 2, "3000", { debit: 100n });
    });
  });
});
