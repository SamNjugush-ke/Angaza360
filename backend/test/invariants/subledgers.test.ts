// ===========================================================================
// INVARIANTS: the subledgers tie to their GL control accounts
// (the engineering ledger "Accounts Receivable", "Accounts Payable", "Financial Reporting ->
// THE CONTROL-ACCOUNT RECONCILIATION").
//
//   open AR  == GL(1100) − AR raised by failed M-Pesa pushes (a named residual)
//   open AP  == GL(2000) − ad-hoc purchase receipts booked on account (a named residual)
//   GRNI     == GL(2050), absolutely
//
// The residuals are STRUCTURAL and documented; they are computed here with
// independent SQL (the same definitions the engineering ledger records), not taken from the
// reports service. Activity is driven through the real receivables, payables,
// procurement and sales services first, including PARTIAL settlements, so an open
// balance exists on both sides.
// ===========================================================================

import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { createSupplierBill, getApAging, postSupplierBill, recordSupplierPayment } from "../../src/services/payables";
import { getArAging, listOpenCreditSales, recordCustomerReceipt } from "../../src/services/receivables";
import { buildControlReconciliation } from "../../src/services/reports";
import { recordSale } from "../../src/services/sales";
import { schemaOf, tenantDb } from "../setup/tenant";
import {
  actorId,
  createCustomer,
  createProduct,
  createSupplier,
  glNet,
  openTill,
  receiveStock,
} from "../support/fixtures";

const schema = schemaOf();

async function scalar(sql: string): Promise<bigint> {
  const result = await pool.query<{ v: string | null }>(sql);
  return BigInt(result.rows[0]?.v ?? "0");
}

/** Independent: Σ over COMPLETED sales of (Σ CREDIT tenders − arReceived). */
function openArSql(): Promise<bigint> {
  return scalar(
    `SELECT COALESCE(SUM(c.credit - s."arReceived"), 0)::text AS v
       FROM "${schema}".sales s
       JOIN (SELECT "saleId", SUM("amount") AS credit FROM "${schema}".sale_tenders
              WHERE "tenderType" = 'CREDIT' GROUP BY "saleId") c ON c."saleId" = s."id"
      WHERE s."status" = 'COMPLETED'`,
  );
}

/** Independent: the 1100 debit raised by every failed / timed-out M-Pesa push. */
function mpesaResidualSql(): Promise<bigint> {
  return scalar(
    `SELECT COALESCE(SUM(l."debit" - l."credit"), 0)::text AS v
       FROM "${schema}".mpesa_transactions m
       JOIN "${schema}".journal_lines l ON l."entryId" = m."reversalEntryId"
       JOIN "${schema}".accounts a ON a."id" = l."accountId"
      WHERE a."code" = '1100'`,
  );
}

/** Independent: Σ unpaid balance of every posted, unsettled supplier bill. */
function openApSql(): Promise<bigint> {
  return scalar(
    `SELECT COALESCE(SUM("total" - "amountPaid"), 0)::text AS v FROM "${schema}".supplier_bills
      WHERE "status" IN ('AWAITING_PAYMENT', 'PARTIALLY_PAID')`,
  );
}

/** Independent: 2000 credits from ad-hoc purchase receipts (stock booked with no PO). */
function adHocResidualSql(): Promise<bigint> {
  return scalar(
    `SELECT COALESCE(SUM(l."credit" - l."debit"), 0)::text AS v
       FROM "${schema}".stock_movements sm
       JOIN "${schema}".journal_lines l ON l."entryId" = sm."journalEntryId"
       JOIN "${schema}".accounts a ON a."id" = l."accountId"
      WHERE sm."movementType" = 'PURCHASE_RECEIPT' AND sm."goodsReceiptId" IS NULL AND a."code" = '2000'`,
  );
}

beforeAll(async () => {
  const db = tenantDb();
  const supplierId = await createSupplier(db);
  const productId = await createProduct(db, { price: 100000n, taxClass: "ZERO_RATED" });
  const { order } = await receiveStock(db, supplierId, [{ productId, quantity: "6", unitCost: 50000n }]);

  // --- AR: a split cash + credit sale, then a PARTIAL receipt against it. ---
  const customerId = await createCustomer(db, 50000000n);
  const till = await openTill(db);
  const sale = await recordSale(db, {
    shiftId: till.shiftId,
    createdBy: till.cashierId,
    customerId,
    lines: [{ productId, quantity: "3" }],
    tenders: [
      { tenderType: "CASH", amount: "1000.00" },
      { tenderType: "CREDIT", amount: "2000.00" },
    ],
  });
  await recordCustomerReceipt(db, {
    customerId,
    receiptDate: new Date(),
    method: "BANK",
    amount: 120000n,
    allocations: [{ saleId: sale.id, amount: 120000n }],
    createdById: actorId(),
  });

  // --- AP: bill the PO in full, post it, then PARTIALLY pay it. ---
  const poLine = order.lines[0];
  if (poLine === undefined) throw new Error("purchase order has no line");
  const draft = await createSupplierBill(db, {
    supplierId,
    billNumber: `INV-${order.poNumber.toString()}`,
    poId: order.id,
    billDate: new Date(),
    lines: [{ description: "PO line", quantity: "6", unitCost: 50000n, purchaseOrderLineId: poLine.id }],
    createdById: actorId(),
  });
  const bill = await postSupplierBill(db, draft.id, actorId());
  expect(bill.status).toBe("AWAITING_PAYMENT");
  await recordSupplierPayment(db, {
    supplierId,
    paymentDate: new Date(),
    method: "BANK",
    amount: 100000n,
    allocations: [{ billId: bill.id, amount: 100000n }],
    createdById: actorId(),
  });
});

describe("accounts receivable", () => {
  it("open AR (independent SQL) == GL(1100) − the M-Pesa-failure residual", async () => {
    const openAr = await openArSql();
    expect(openAr, "the partial receipt should leave an open balance to reconcile").toBeGreaterThan(0n);
    expect(openAr).toBe((await glNet(schema, "1100")) - (await mpesaResidualSql()));
  });

  it("== Σ Customer.creditBalance == the service's open-sale worklist == the aging grand total", async () => {
    const openAr = await openArSql();
    expect(await scalar(`SELECT COALESCE(SUM("creditBalance"), 0)::text AS v FROM "${schema}".customers`)).toBe(openAr);
    const open = await listOpenCreditSales(tenantDb());
    expect(open.reduce((sum, row) => sum + row.outstanding, 0n)).toBe(openAr);
    expect((await getArAging(tenantDb())).grandTotal).toBe(openAr);
  });
});

describe("accounts payable", () => {
  it("open AP (independent SQL) == GL(2000) − the ad-hoc-receipt residual", async () => {
    const openAp = await openApSql();
    expect(openAp, "the partial payment should leave an open balance to reconcile").toBeGreaterThan(0n);
    const gl2000 = -(await glNet(schema, "2000")); // credit-nature
    expect(openAp).toBe(gl2000 - (await adHocResidualSql()));
  });

  it("== the AP aging grand total", async () => {
    expect((await getApAging(tenantDb())).grandTotal).toBe(await openApSql());
  });

  it("GRNI: GL(2050) == received-not-yet-billed, absolutely", async () => {
    const accrued = await scalar(
      `SELECT COALESCE(SUM("totalCost"), 0)::text AS v FROM "${schema}".stock_movements WHERE "goodsReceiptId" IS NOT NULL`,
    );
    const cleared = await scalar(
      `SELECT COALESCE(SUM(bl."grniCleared"), 0)::text AS v
         FROM "${schema}".supplier_bill_lines bl JOIN "${schema}".supplier_bills b ON b."id" = bl."billId"
        WHERE b."status" NOT IN ('DRAFT', 'CANCELLED')`,
    );
    expect(-(await glNet(schema, "2050"))).toBe(accrued - cleared);
  });
});

describe("the Module 13 control reconciliation agrees", () => {
  it("every control reconciles with 0 unexplained, and its figures match the independent SQL", async () => {
    const recon = await buildControlReconciliation(tenantDb(), schema);
    for (const item of recon.items) {
      expect(item.unexplained, `${item.control} (${item.accountCode}) unexplained`).toBe(0n);
    }
    expect(recon.allReconcile).toBe(true);
    const ar = recon.items.find((item) => item.control === "ACCOUNTS_RECEIVABLE");
    const ap = recon.items.find((item) => item.control === "ACCOUNTS_PAYABLE");
    expect(ar?.subledger).toBe(await openArSql());
    expect(ap?.subledger).toBe(await openApSql());
    expect(ap?.glBalance).toBe(-(await glNet(schema, "2000")));
    expect(ar?.glBalance).toBe(await glNet(schema, "1100"));
  });
});
