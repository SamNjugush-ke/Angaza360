// ===========================================================================
// FAIL-CLOSED DATABASE GUARDS, attacked from outside the service layer.
//
//   * payment_fully_allocated_check_on_payment (migration 0019) -> assert_payment_fully_allocated():
//     a supplier payment with ZERO allocation rows is refused at COMMIT. This is the
//     binding 0018 lacked and the adversarial half of Task 5.2 found missing.
//   * journal_entry_period_lock (migrations 0003/0004) -> journal_entry_period_lock():
//     nothing posts into a CLOSED accounting period, whoever writes it.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import {
  closePeriod,
  PeriodClosedError,
  postJournalEntry,
  reopenPeriod,
} from "../../src/services/ledger";
import { PayablesValidationError, recordSupplierPayment } from "../../src/services/payables";
import { FIXTURE_SUBDOMAIN, schemaOf, tenantDb, withTenantTx } from "../setup/tenant";
import { actorId, createSupplier } from "../support/fixtures";
import { expectDbRefusal } from "../support/db-errors";

const schema = schemaOf();

describe("payment_fully_allocated_check (migration 0019)", () => {
  let supplierId = "";

  beforeAll(async () => {
    supplierId = await createSupplier(tenantDb());
  });

  async function insertUnallocatedPayment(client: PoolClient, id: string): Promise<void> {
    await client.query(
      `INSERT INTO "${schema}".supplier_payments
         ("id", "paymentNumber", "supplierId", "paymentDate", "method", "amount", "createdById")
       VALUES ($1, nextval('"${schema}".supplier_payment_number_seq'), $2, CURRENT_DATE, 'CASH', 50000, 'qa-adversary')`,
      [id, supplierId],
    );
  }

  it("the service refuses a payment with no allocations (ergonomics layer)", async () => {
    await expect(
      recordSupplierPayment(tenantDb(), {
        supplierId,
        paymentDate: new Date(),
        method: "CASH",
        amount: 50000n,
        allocations: [],
        createdById: actorId(),
      }),
    ).rejects.toBeInstanceOf(PayablesValidationError);
  });

  it("the DATABASE refuses a zero-allocation supplier payment at COMMIT", async () => {
    const id = randomUUID();
    await expectDbRefusal(
      withTenantTx(FIXTURE_SUBDOMAIN, (client) => insertUnallocatedPayment(client, id), "commit"),
      {
        fn: "assert_payment_fully_allocated",
        code: "P0001",
        message: /is 50000 cents but 0 cents are allocated/,
      },
    );
    const left = await pool.query(`SELECT 1 FROM "${schema}".supplier_payments WHERE "id" = $1`, [id]);
    expect(left.rowCount).toBe(0);
  });

  it("the payment-side binding exists, deferred, on supplier_payments itself", async () => {
    const binding = await pool.query<{ fn: string; deferred: boolean }>(
      `SELECT p.proname AS fn, t.tginitdeferred AS deferred
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = $1 AND c.relname = 'supplier_payments'
          AND t.tgname = 'payment_fully_allocated_check_on_payment'`,
      [schema],
    );
    expect(binding.rows).toEqual([{ fn: "assert_payment_fully_allocated", deferred: true }]);
  });
});

describe("journal_entry_period_lock", () => {
  // January 2026 carries no other test activity; it is closed for this file and
  // reopened afterwards so no other file is affected.
  const YEAR = 2026;
  const MONTH = 1;
  const owner = actorId();

  beforeAll(async () => {
    const closed = await closePeriod(tenantDb(), YEAR, MONTH, owner);
    expect(closed.status).toBe("CLOSED");
  });

  afterAll(async () => {
    await reopenPeriod(tenantDb(), YEAR, MONTH, owner);
  });

  it("the ledger service refuses a posting dated in the closed period", async () => {
    await expect(
      postJournalEntry(tenantDb(), {
        entryDate: new Date(Date.UTC(YEAR, MONTH - 1, 15)),
        description: "into a closed period",
        source: "MANUAL",
        createdBy: actorId(),
        lines: [
          { accountCode: "1000", debit: 100n },
          { accountCode: "3000", credit: 100n },
        ],
      }),
    ).rejects.toBeInstanceOf(PeriodClosedError);
  });

  it("the DATABASE refuses a raw INSERT into the closed period — journal_entry_period_lock()", async () => {
    await expectDbRefusal(
      withTenantTx(FIXTURE_SUBDOMAIN, (client) =>
        client.query(
          `INSERT INTO "${schema}".journal_entries
             ("id", "entryNumber", "entryDate", "periodYear", "periodMonth", "description", "source", "createdBy")
           VALUES ($1, $2, DATE '2026-01-15', $3, $4, 'T-A1 adversarial', 'MANUAL', 'qa-adversary')`,
          [randomUUID(), `QA-LOCK-${randomUUID().slice(0, 8)}`, YEAR, MONTH],
        ),
      ),
      { fn: "journal_entry_period_lock", code: "P0001", message: /Accounting period 2026-1 is CLOSED/ },
    );
  });

  it("control: the identical raw INSERT into an OPEN period passes the lock", async () => {
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client) => {
      const inserted = await client.query(
        `INSERT INTO "${schema}".journal_entries
           ("id", "entryNumber", "entryDate", "periodYear", "periodMonth", "description", "source", "createdBy")
         VALUES ($1, $2, DATE '2026-02-15', 2026, 2, 'T-A1 control', 'MANUAL', 'qa-adversary')`,
        [randomUUID(), `QA-OPEN-${randomUUID().slice(0, 8)}`],
      );
      expect(inserted.rowCount).toBe(1);
    }); // rolled back before the deferred balance check could matter
  });
});
