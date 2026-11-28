// ===========================================================================
// THE ONLINE POS SALE POSTS FULLY PAID (Task T-B-POS-PAY-B), through the REAL app.
//
// POST /v1/pos/sales posts every tender CONFIRMED to its real account: cash → 1000 (the AMOUNT;
// the change is not posted, and cashReceived is stored for the receipt's change), M-Pesa →
// 1010 with its channel — linked to a CONFIRMED pre-sale STK from the tender side, or confirmed
// by a manual reference — bank → 1020, credit → 1100. The legacy post-first path (a PENDING
// MPESA tender in 1015) and the offline replay are unchanged.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { pool } from "../../src/db/pool";
import { buildServer } from "../../src/server";
import { createLocation } from "../../src/services/locations";
import { recordStockMovement } from "../../src/services/inventory";
import { registerDevice, startLease } from "../../src/services/offline/custody";
import { ingestSyncBatch } from "../../src/services/offline/sync";
import { recordSale } from "../../src/services/sales";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { dropTenant, provisionFixture, schemaOf, tenantDb, tenantIdOf } from "../setup/tenant";
import { actorId, uniq, assignCashier } from "../support/fixtures";

const TENANT = "qa-paid";
const PHONE = "254712345678";

let app: FastifyInstance;
const users: StaffUser[] = [];
let owner: SignedIn;
let goodId = "";
let serviceId = "";

interface Tender {
  id: string;
  tenderType: string;
  amount: string;
  status: string;
  mpesaReference: string | null;
  mpesaTransactionId: string | null;
  mpesaChannel: string | null;
  cashReceived: string | null;
}
interface Sale {
  id: string;
  total: string;
  paymentStatus: string;
  saleJournalEntryId: string;
  tenders: Tender[];
}

function send(method: "GET" | "POST", url: string, signedIn: SignedIn, payload?: unknown) {
  return app.inject({ method, url, remoteAddress: freshIp(), headers: bearer(signedIn.token), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}

/** A fresh cashier with an open shift (one open shift per cashier). */
async function till(openingFloat = "0.00"): Promise<{ cashier: SignedIn; shiftId: string }> {
  const user = await createStaffUser("CASHIER", await tenantIdOf(TENANT));
  users.push(user);
  await assignCashier(tenantDb(TENANT), user.id);
  const cashier = await signIn(app, user);
  const shift = await send("POST", "/v1/pos/shifts/open", cashier, { openingFloat });
  expect(shift.statusCode).toBe(201);
  return { cashier, shiftId: shift.json<{ id: string }>().id };
}

/** One good at 1,000.00: a sale of one is exactly 1,000.00 (a Turnover-Tax tenant charges no VAT). */
function oneGood() {
  return [{ productId: goodId, quantity: "1" }];
}

async function sell(cashier: SignedIn, shiftId: string, tenders: unknown[], extra: Record<string, unknown> = {}) {
  return send("POST", "/v1/pos/sales", cashier, { shiftId, lines: oneGood(), tenders, ...extra });
}

/** The tender-side debits of a sale's journal entry, by account — read with independent SQL. */
async function debits(entryId: string): Promise<Record<string, string>> {
  const schema = schemaOf(TENANT);
  const rows = await pool.query<{ code: string; debit: string }>(
    `SELECT a."code", SUM(l."debit")::text AS debit FROM "${schema}".journal_lines l JOIN "${schema}".accounts a ON a."id" = l."accountId"
      WHERE l."entryId" = $1 AND l."debit" > 0 AND a."code" IN ('1000', '1010', '1015', '1020', '1100') GROUP BY a."code" ORDER BY a."code"`,
    [entryId],
  );
  return Object.fromEntries(rows.rows.map((row) => [row.code, row.debit]));
}

async function balances(entryId: string): Promise<boolean> {
  const schema = schemaOf(TENANT);
  const rows = await pool.query<{ d: string; c: string }>(`SELECT SUM("debit")::text AS d, SUM("credit")::text AS c FROM "${schema}".journal_lines WHERE "entryId" = $1`, [entryId]);
  return rows.rows[0]?.d === rows.rows[0]?.c;
}

async function confirmedPush(amount: string): Promise<string> {
  const pushed = await send("POST", "/v1/pos/mpesa/stk-push", owner, { phoneNumber: PHONE, amount });
  expect(pushed.statusCode).toBe(201);
  const checkoutRequestId = pushed.json<{ checkoutRequestId: string }>().checkoutRequestId;
  expect((await send("POST", "/v1/dev/mpesa/deliver", owner, { checkoutRequestId, outcome: "success" })).statusCode).toBe(200);
  return checkoutRequestId;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  await dropTenant(TENANT);
  await provisionFixture(TENANT, "QA Paid Sales");
  const user = await createStaffUser("MSME_OWNER", await tenantIdOf(TENANT));
  users.push(user);
  owner = await signIn(app, user);
  const db = tenantDb(TENANT);
  const good = await db.product.create({ data: { sku: uniq("PAID"), name: "Paid good", costPrice: 40000n, price: 100000n } });
  await recordStockMovement(db, { productId: good.id, movementType: "OPENING_BALANCE", quantity: "100", unitCost: 40000n, createdBy: actorId() });
  goodId = good.id;
  serviceId = (await db.product.create({ data: { sku: uniq("PSVC"), name: "Paid service", costPrice: 0n, price: 100000n, kind: "SERVICE" } })).id;
});

afterAll(async () => {
  await platformDb.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await dropTenant(TENANT);
  await app.close();
});

describe("cash", () => {
  it("records the cash received: the receipt shows the change, the ledger and the drawer take only the amount", async () => {
    const { cashier, shiftId } = await till("200.00");
    const sold = await sell(cashier, shiftId, [{ tenderType: "CASH", amount: "1000.00", cashReceived: "1500.00" }]);
    expect(sold.statusCode).toBe(201);
    const sale = sold.json<Sale>();
    expect(sale.tenders[0]).toMatchObject({ tenderType: "CASH", amount: "100000", cashReceived: "150000", status: "CONFIRMED", mpesaChannel: null });
    expect(await debits(sale.saleJournalEntryId)).toEqual({ "1000": "100000" });
    expect(await balances(sale.saleJournalEntryId)).toBe(true);

    const receipt = (await send("GET", `/v1/pos/sales/${sale.id}/receipt`, cashier)).json<{ amountTendered: string; changeDue: string }>();
    expect([receipt.amountTendered, receipt.changeDue]).toEqual(["150000", "50000"]);

    // The drawer holds the float + the sale; the change went back to the customer.
    const closed = await send("POST", `/v1/pos/shifts/${shiftId}/close`, cashier, { closingFloat: "1200.00" });
    expect(closed.json<{ expectedCash: string; variance: string }>()).toMatchObject({ expectedCash: "120000", variance: "0" });
  });

  it("refuses cash received below the amount, and cash received on any other tender", async () => {
    const { cashier, shiftId } = await till();
    const short = await sell(cashier, shiftId, [{ tenderType: "CASH", amount: "1000.00", cashReceived: "999.99" }]);
    expect([short.statusCode, short.json<{ message: string }>().message]).toEqual([400, "Tender 1: the cash received is less than the amount this tender pays."]);
    const misplaced = await sell(cashier, shiftId, [{ tenderType: "BANK_TRANSFER", amount: "1000.00", cashReceived: "1000.00" }]);
    expect(misplaced.statusCode).toBe(400);
  });
});

describe("M-Pesa, confirmed before the sale", () => {
  it("a manual Till payment posts to 1010, CONFIRMED, with its channel and reference", async () => {
    const { cashier, shiftId } = await till();
    const sold = await sell(cashier, shiftId, [{ tenderType: "MPESA", amount: "1000.00", mpesaChannel: "TILL", mpesaReference: "QK12ABC3XY" }]);
    expect(sold.statusCode).toBe(201);
    const sale = sold.json<Sale>();
    expect(sale.tenders[0]).toMatchObject({ status: "CONFIRMED", mpesaChannel: "TILL", mpesaReference: "QK12ABC3XY", mpesaTransactionId: null });
    expect(sale.paymentStatus).toBe("FULLY_SETTLED");
    expect(await debits(sale.saleJournalEntryId)).toEqual({ "1010": "100000" });
    expect(await balances(sale.saleJournalEntryId)).toBe(true);
  });

  it("refuses an M-Pesa tender with no confirmation, or a manual reference with no channel", async () => {
    const { cashier, shiftId } = await till();
    const none = await sell(cashier, shiftId, [{ tenderType: "MPESA", amount: "1000.00" }]);
    expect(none.statusCode).toBe(400);
    expect(none.json<{ message: string }>().message).toMatch(/needs its confirmation/);
    const noChannel = await sell(cashier, shiftId, [{ tenderType: "MPESA", amount: "1000.00", mpesaReference: "QK12ABC3XY" }]);
    expect(noChannel.json<{ message: string }>().message).toMatch(/needs its channel/);
  });

  it("a confirmed pre-sale STK links from the TENDER side, posts to 1010, and can pay only one sale", async () => {
    const { cashier, shiftId } = await till();
    const checkout = await confirmedPush("1000.00");
    const sold = await sell(cashier, shiftId, [{ tenderType: "MPESA", amount: "1000.00", mpesaCheckoutRequestId: checkout }]);
    expect(sold.statusCode).toBe(201);
    const sale = sold.json<Sale>();
    const txn = await tenantDb(TENANT).mpesaTransaction.findUniqueOrThrow({ where: { checkoutRequestId: checkout } });
    expect(sale.tenders[0]).toMatchObject({ status: "CONFIRMED", mpesaChannel: "STK", mpesaTransactionId: txn.id, mpesaReference: txn.mpesaReceiptNumber });
    expect(await debits(sale.saleJournalEntryId)).toEqual({ "1010": "100000" });
    // The transaction itself is never written: its saleId stays null (the trigger freezes it).
    expect([txn.saleId, txn.tenderId, txn.status]).toEqual([null, null, "CALLBACK_OK"]);

    const again = await sell(cashier, shiftId, [{ tenderType: "MPESA", amount: "1000.00", mpesaCheckoutRequestId: checkout }]);
    expect([again.statusCode, again.json<{ message: string }>().message]).toEqual([400, "Tender 1: that M-Pesa payment has already been used for another sale."]);
  });

  it("refuses an STK payment of a different amount, an unconfirmed one, and a failed one", async () => {
    const { cashier, shiftId } = await till();
    const short = await confirmedPush("999.00");
    expect((await sell(cashier, shiftId, [{ tenderType: "MPESA", amount: "1000.00", mpesaCheckoutRequestId: short }])).json<{ message: string }>().message).toMatch(/amount does not match/);
    const pending = (await send("POST", "/v1/pos/mpesa/stk-push", owner, { phoneNumber: PHONE, amount: "1000.00" })).json<{ checkoutRequestId: string }>().checkoutRequestId;
    expect((await sell(cashier, shiftId, [{ tenderType: "MPESA", amount: "1000.00", mpesaCheckoutRequestId: pending }])).json<{ message: string }>().message).toMatch(/not been confirmed \(it is INITIATED\)/);
    await send("POST", "/v1/dev/mpesa/deliver", owner, { checkoutRequestId: pending, outcome: "failure" });
    expect((await sell(cashier, shiftId, [{ tenderType: "MPESA", amount: "1000.00", mpesaCheckoutRequestId: pending }])).json<{ message: string }>().message).toMatch(/CALLBACK_FAILED/);
    expect((await sell(cashier, shiftId, [{ tenderType: "MPESA", amount: "1000.00", mpesaCheckoutRequestId: "ws_CO_nonexistent" }])).statusCode).toBe(400);
  });
});

describe("bank, credit and a split", () => {
  it("a bank transfer posts to 1020", async () => {
    const { cashier, shiftId } = await till();
    const sale = (await sell(cashier, shiftId, [{ tenderType: "BANK_TRANSFER", amount: "1000.00" }])).json<Sale>();
    expect(await debits(sale.saleJournalEntryId)).toEqual({ "1020": "100000" });
    expect(await balances(sale.saleJournalEntryId)).toBe(true);
  });

  it("500 cash / 300 M-Pesa / 200 credit: each to its account, the credit on the customer, loyalty on the whole confirmed total", async () => {
    const db = tenantDb(TENANT);
    const customer = await db.customer.create({ data: { name: uniq("Split"), creditLimit: 100000n } });
    const { cashier, shiftId } = await till();
    const sold = await sell(
      cashier,
      shiftId,
      [
        { tenderType: "CASH", amount: "500.00" },
        { tenderType: "MPESA", amount: "300.00", mpesaChannel: "PAYBILL", mpesaReference: "QK99XYZ" },
        { tenderType: "CREDIT", amount: "200.00" },
      ],
      { customerId: customer.id },
    );
    expect(sold.statusCode).toBe(201);
    const sale = sold.json<Sale>();
    expect(await debits(sale.saleJournalEntryId)).toEqual({ "1000": "50000", "1010": "30000", "1100": "20000" });
    expect(await balances(sale.saleJournalEntryId)).toBe(true);
    expect(sale.paymentStatus).toBe("FULLY_SETTLED");
    expect(sale.tenders.map((t) => t.status)).toEqual(["CONFIRMED", "CONFIRMED", "CONFIRMED"]);
    const after = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.creditBalance).toBe(20000n);
    // 1,000.00 confirmed (the M-Pesa portion included) → 10 points; under the legacy PENDING
    // M-Pesa it would have been 7.
    expect(after.loyaltyPoints).toBe(10);
    const open = (await send("GET", "/v1/receivables/open", owner)).json<{ data: Array<{ saleId: string; outstanding: string }> }>();
    expect(open.data.find((row) => row.saleId === sale.id)?.outstanding).toBe("20000");
  });

  it("an all-credit sale posts to 1100 and accrues loyalty", async () => {
    const db = tenantDb(TENANT);
    const customer = await db.customer.create({ data: { name: uniq("Credit"), creditLimit: 500000n } });
    const { cashier, shiftId } = await till();
    const sale = (await sell(cashier, shiftId, [{ tenderType: "CREDIT", amount: "1000.00" }], { customerId: customer.id })).json<Sale>();
    expect(await debits(sale.saleJournalEntryId)).toEqual({ "1100": "100000" });
    expect(await balances(sale.saleJournalEntryId)).toBe(true);
    expect((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).loyaltyPoints).toBe(10);
  });
});

describe("REGRESSION: the legacy and offline paths are unchanged", () => {
  it("an all-cash sale posts the same ledger and stock as the pre-PAY-B atomic sale", async () => {
    const { cashier, shiftId } = await till();
    const online = (await sell(cashier, shiftId, [{ tenderType: "CASH", amount: "1000.00" }])).json<Sale>();
    const legacy = await recordSale(tenantDb(TENANT), { shiftId, lines: oneGood(), tenders: [{ tenderType: "CASH", amount: "1000.00" }], createdBy: cashier.user.id });
    const schema = schemaOf(TENANT);
    const shape = async (entryId: string) =>
      (
        await pool.query<{ code: string; debit: string; credit: string }>(
          `SELECT a."code", l."debit"::text AS debit, l."credit"::text AS credit FROM "${schema}".journal_lines l JOIN "${schema}".accounts a ON a."id" = l."accountId" WHERE l."entryId" = $1 ORDER BY a."code", l."debit"`,
          [entryId],
        )
      ).rows;
    expect(await shape(online.saleJournalEntryId)).toEqual(await shape(legacy.saleJournalEntryId ?? ""));
    // Each sale wrote one SALE movement for the good: the two are identical in quantity and cost.
    const movements = (
      await pool.query<{ q: string; c: string; t: string }>(
        `SELECT "quantity"::text AS q, "totalCost"::text AS c, "movementType"::text AS t FROM "${schema}".stock_movements
          WHERE "productId" = $1 AND "movementType" = 'SALE' ORDER BY "createdAt" DESC LIMIT 2`,
        [goodId],
      )
    ).rows;
    expect(movements).toHaveLength(2);
    expect(movements[0]).toEqual(movements[1]);
    expect(legacy.tenders[0]).toMatchObject({ status: "CONFIRMED", cashReceived: null, mpesaChannel: null });
  });

  it("the legacy post-first sale still parks an M-Pesa tender PENDING in 1015, and refuses the new fields", async () => {
    const { cashier, shiftId } = await till();
    const legacy = await recordSale(tenantDb(TENANT), { shiftId, lines: oneGood(), tenders: [{ tenderType: "MPESA", amount: "1000.00" }], createdBy: cashier.user.id });
    expect(legacy.tenders[0]).toMatchObject({ status: "PENDING", mpesaChannel: null });
    expect(await debits(legacy.saleJournalEntryId ?? "")).toEqual({ "1015": "100000" });
    await expect(
      recordSale(tenantDb(TENANT), { shiftId, lines: oneGood(), tenders: [{ tenderType: "CASH", amount: "1000.00", cashReceived: "1000.00" }], createdBy: cashier.user.id }),
    ).rejects.toThrow(/only on a pre-confirmed online sale/);
  });

  it("an offline capture with an M-Pesa tender still replays PENDING in 1015", async () => {
    const db = tenantDb(TENANT);
    const { shiftId } = await till();
    const location = await createLocation(db, { name: "Paid till", code: uniq("PT"), type: "POS", isOfflineCapable: true, leaseWindowMinutes: null });
    const device = await registerDevice(db, { deviceName: "Paid tablet", locationId: location.id, registeredBy: actorId() });
    await startLease(db, device.id);
    const result = await ingestSyncBatch(db, {
      deviceId: device.id,
      syncedBy: actorId(),
      sales: [{ idempotencyKey: uniq("paid-offline"), businessTimestamp: new Date(), shiftId, lines: [{ productId: serviceId, quantity: "1" }], tenders: [{ tenderType: "MPESA", amount: "1000.00" }] }],
    });
    expect(result.summary.posted).toBe(1);
    const synced = await db.sale.findFirstOrThrow({ where: { deviceId: device.id }, include: { tenders: true } });
    expect(synced.tenders[0]).toMatchObject({ status: "PENDING", mpesaChannel: null });
    expect(await debits(synced.saleJournalEntryId ?? "")).toEqual({ "1015": "100000" });
  });
});
