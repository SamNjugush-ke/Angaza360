// ===========================================================================
// PRE-SALE (STANDALONE) M-PESA STK and the two tender columns (Task T-B-POS-PAY-A),
// through the REAL app and the simulated provider.
//
// * POST /v1/pos/mpesa/stk-push asks for money BEFORE any sale exists: the transaction has
//   no saleId and no tenderId. Its callback — delivered through the REAL webhook by
//   /v1/dev/mpesa/deliver — records CALLBACK_OK with the receipt, or CALLBACK_FAILED, and
//   the sweep records TIMED_OUT; NONE of them posts a journal entry (there is no sale yet).
// * REGRESSION: the legacy sale-linked STK still posts 1015 → 1010 on success and
//   1015 → 1100 on failure.
// * Migration 0031: mpesaChannel only on MPESA, cashReceived only on CASH and ≥ amount, both
//   write-once — attacked from raw SQL with a control.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { pool } from "../../src/db/pool";
import type { UserRole } from "../../src/generated/platform/enums";
import { buildServer } from "../../src/server";
import { recordStockMovement } from "../../src/services/inventory";
import { expireStalePending } from "../../src/services/mpesa/payment";
import { recordSale } from "../../src/services/sales";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { dropTenant, provisionFixture, schemaOf, tenantDb, tenantIdOf, withTenantTx } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { actorId, glNet, uniq, assignCashier } from "../support/fixtures";

const A = "qa-mpesa-a";
const B = "qa-mpesa-b";
const PHONE = "254712345678";

let app: FastifyInstance;
const users: StaffUser[] = [];
const sessions = new Map<string, SignedIn>();
let productId = "";

interface PushResult {
  checkoutRequestId: string;
  mpesaTransactionId: string;
  status: string;
}
interface TxnStatus {
  status: string;
  amount: string;
  mpesaReceiptNumber: string | null;
  saleId: string | null;
  tenderId: string | null;
  resultDesc: string | null;
}

const who = (tenant: string, role: UserRole = "CASHIER") => sessions.get(`${tenant}:${role}`) as SignedIn;

function send(method: "GET" | "POST", url: string, signedIn: SignedIn | null, payload?: unknown) {
  return app.inject({ method, url, remoteAddress: freshIp(), headers: signedIn ? bearer(signedIn.token) : {}, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}

async function push(tenant: string, amount = "1500.00", role: UserRole = "CASHIER"): Promise<PushResult> {
  const response = await send("POST", "/v1/pos/mpesa/stk-push", who(tenant, role), { phoneNumber: PHONE, amount });
  expect(response.statusCode).toBe(201);
  return response.json<PushResult>();
}
async function deliver(tenant: string, checkoutRequestId: string, outcome: "success" | "failure" | "amount_mismatch") {
  const response = await send("POST", "/v1/dev/mpesa/deliver", who(tenant), { checkoutRequestId, outcome });
  expect(response.statusCode).toBe(200);
  return response.json<{ webhookStatus: number; webhookBody: Record<string, unknown> }>();
}
async function poll(tenant: string, checkoutRequestId: string) {
  return send("GET", `/v1/pos/mpesa/${checkoutRequestId}`, who(tenant));
}

/** Rows in the journal — a pre-sale transaction must not add one. */
async function journalRows(tenant: string): Promise<{ entries: number; lines: number }> {
  const schema = schemaOf(tenant);
  const rows = await pool.query<{ entries: number; lines: number }>(
    `SELECT (SELECT count(*)::int FROM "${schema}".journal_entries) AS entries, (SELECT count(*)::int FROM "${schema}".journal_lines) AS lines`,
  );
  return rows.rows[0] ?? { entries: -1, lines: -1 };
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  for (const tenant of [A, B]) {
    await dropTenant(tenant);
    await provisionFixture(tenant, tenant === A ? "QA M-Pesa A" : "QA M-Pesa B");
    const tenantId = await tenantIdOf(tenant);
    for (const role of ["CASHIER", "MSME_MANAGER", "MSME_OWNER", "ACCOUNTANT", "VIEWER_AUDITOR", "WAREHOUSE_STAFF"] as const) {
      const user = await createStaffUser(role, tenantId);
      users.push(user);
      if (role === "CASHIER") await assignCashier(tenantDb(tenant), user.id);
      sessions.set(`${tenant}:${role}`, await signIn(app, user));
    }
  }
  const db = tenantDb(A);
  const product = await db.product.create({ data: { sku: uniq("MP"), name: "M-Pesa item", costPrice: 10000n, price: 50000n } });
  await recordStockMovement(db, { productId: product.id, movementType: "OPENING_BALANCE", quantity: "20", unitCost: 10000n, createdBy: actorId() });
  productId = product.id;
});

afterAll(async () => {
  await platformDb.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  for (const tenant of [A, B]) await dropTenant(tenant);
  await app.close();
});

describe("a pre-sale STK push", () => {
  it("is created with no sale and no tender, and a success callback records the receipt — posting NO journal entry", async () => {
    const before = await journalRows(A);
    const pushed = await push(A);
    expect(pushed.status).toBe("INITIATED");
    const pending = (await poll(A, pushed.checkoutRequestId)).json<TxnStatus>();
    expect(pending).toMatchObject({ status: "INITIATED", amount: "150000", saleId: null, tenderId: null, mpesaReceiptNumber: null });

    const delivered = await deliver(A, pushed.checkoutRequestId, "success");
    expect(delivered.webhookStatus).toBe(200);
    expect(delivered.webhookBody["status"]).toBe("confirmed");
    const done = (await poll(A, pushed.checkoutRequestId)).json<TxnStatus>();
    expect(done.status).toBe("CALLBACK_OK");
    expect(done.mpesaReceiptNumber).toMatch(/\w+/);
    expect(done.saleId).toBeNull();
    expect(await journalRows(A)).toEqual(before);

    // A replayed callback is a no-op.
    const replay = await deliver(A, pushed.checkoutRequestId, "failure");
    expect(replay.webhookBody["status"]).toBe("already_processed");
    expect((await poll(A, pushed.checkoutRequestId)).json<TxnStatus>().status).toBe("CALLBACK_OK");
    expect(await journalRows(A)).toEqual(before);
  });

  it("a failure or an amount mismatch records CALLBACK_FAILED and posts nothing", async () => {
    const before = await journalRows(A);
    const failed = await push(A);
    expect((await deliver(A, failed.checkoutRequestId, "failure")).webhookBody["status"]).toBe("failed");
    expect((await poll(A, failed.checkoutRequestId)).json<TxnStatus>()).toMatchObject({ status: "CALLBACK_FAILED", mpesaReceiptNumber: null });
    const mismatch = await push(A);
    expect((await deliver(A, mismatch.checkoutRequestId, "amount_mismatch")).webhookBody["reason"]).toBe("amount_mismatch");
    expect((await poll(A, mismatch.checkoutRequestId)).json<TxnStatus>().resultDesc).toMatch(/Amount mismatch/);
    expect(await journalRows(A)).toEqual(before);
  });

  it("an abandoned push times out in the sweep, posting nothing", async () => {
    const pushed = await push(A);
    await withTenantTx(A, (client, schema) => client.query(`UPDATE "${schema}".mpesa_transactions SET "initiatedAt" = now() - interval '2 hours' WHERE "checkoutRequestId" = $1`, [pushed.checkoutRequestId]), "commit");
    const before = await journalRows(A);
    const swept = await expireStalePending(tenantDb(A), 60);
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect((await poll(A, pushed.checkoutRequestId)).json<TxnStatus>()).toMatchObject({ status: "TIMED_OUT", saleId: null });
    expect(await journalRows(A)).toEqual(before);
  });

  it("validates the request: a Kenyan mobile number, a positive amount in shillings, a short reference", async () => {
    for (const payload of [
      { phoneNumber: "0712345678", amount: "10.00" },
      { phoneNumber: PHONE, amount: "0.00" },
      { phoneNumber: PHONE, amount: 1500 },
      { phoneNumber: PHONE, amount: "150000" + "x" },
      { phoneNumber: PHONE, amount: "10.00", accountReference: "THIRTEEN-CHAR" },
    ]) {
      expect([payload, (await send("POST", "/v1/pos/mpesa/stk-push", who(A), payload)).statusCode]).toEqual([payload, 400]);
    }
  });
});

describe("isolation and RBAC", () => {
  it("another business can neither poll nor deliver this tenant's push", async () => {
    const pushed = await push(A);
    expect((await poll(B, pushed.checkoutRequestId)).statusCode).toBe(404);
    expect((await send("POST", "/v1/dev/mpesa/deliver", who(B), { checkoutRequestId: pushed.checkoutRequestId, outcome: "success" })).statusCode).toBe(404);
    expect((await poll(A, pushed.checkoutRequestId)).json<TxnStatus>().status).toBe("INITIATED");
  });

  it("is for the till roles only", async () => {
    for (const role of ["CASHIER", "MSME_MANAGER", "MSME_OWNER"] as const) await push(A, "5.00", role);
    for (const role of ["ACCOUNTANT", "VIEWER_AUDITOR", "WAREHOUSE_STAFF"] as const) {
      expect([role, (await send("POST", "/v1/pos/mpesa/stk-push", who(A, role), { phoneNumber: PHONE, amount: "5.00" })).statusCode]).toEqual([role, 403]);
    }
    expect((await send("POST", "/v1/pos/mpesa/stk-push", null, { phoneNumber: PHONE, amount: "5.00" })).statusCode).toBe(401);
  });
});

describe("REGRESSION: the legacy sale-linked STK still posts its clearing entries", () => {
  async function mpesaSale(): Promise<{ saleId: string; tenderId: string }> {
    const shift = await send("POST", "/v1/pos/shifts/open", who(A), { openingFloat: "0.00" });
    const shiftId = shift.statusCode === 201 ? shift.json<{ id: string }>().id : (await send("GET", "/v1/pos/shifts/current", who(A))).json<{ id: string }>().id;
    // The legacy post-first sale (a PENDING MPESA tender in 1015) is posted through the SERVICE
    // with no paymentMode: since PAY-B the POS route always posts fully paid, and this path's
    // remaining callers are service-level (the offline sync).
    const sale = await recordSale(tenantDb(A), { shiftId, lines: [{ productId, quantity: "1" }], tenders: [{ tenderType: "MPESA", amount: "500.00" }], createdBy: who(A).user.id });
    expect(sale.tenders[0]?.status).toBe("PENDING");
    return { saleId: sale.id, tenderId: sale.tenders[0]?.id ?? "" };
  }

  it("success moves 1015 → 1010; failure moves 1015 → 1100", async () => {
    const schema = schemaOf(A);
    const ok = await mpesaSale();
    const [till0, clearing0, ar0] = await Promise.all([glNet(schema, "1010"), glNet(schema, "1015"), glNet(schema, "1100")]);
    const okPush = (await send("POST", `/v1/pos/sales/${ok.saleId}/tenders/${ok.tenderId}/stk-push`, who(A), { phoneNumber: PHONE })).json<PushResult>();
    await deliver(A, okPush.checkoutRequestId, "success");
    expect(await glNet(schema, "1010")).toBe(till0 + 50000n);
    expect(await glNet(schema, "1015")).toBe(clearing0 - 50000n);
    expect((await poll(A, okPush.checkoutRequestId)).json<TxnStatus>()).toMatchObject({ status: "CALLBACK_OK", saleId: ok.saleId, tenderId: ok.tenderId });

    const bad = await mpesaSale();
    const clearing1 = await glNet(schema, "1015");
    const badPush = (await send("POST", `/v1/pos/sales/${bad.saleId}/tenders/${bad.tenderId}/stk-push`, who(A), { phoneNumber: PHONE })).json<PushResult>();
    await deliver(A, badPush.checkoutRequestId, "failure");
    expect(await glNet(schema, "1100")).toBe(ar0 + 50000n);
    expect(await glNet(schema, "1015")).toBe(clearing1 - 50000n);
  });
});

describe("migration 0031: the tender channel and cash-received columns", () => {
  async function aCashSale(): Promise<string> {
    const current = await send("GET", "/v1/pos/shifts/current", who(A));
    const shiftId = current.statusCode === 200 ? current.json<{ id: string }>().id : (await send("POST", "/v1/pos/shifts/open", who(A), { openingFloat: "0.00" })).json<{ id: string }>().id;
    const sold = await send("POST", "/v1/pos/sales", who(A), { shiftId, lines: [{ productId, quantity: "1" }], tenders: [{ tenderType: "CASH", amount: "500.00" }] });
    expect(sold.statusCode).toBe(201);
    return sold.json<{ id: string }>().id;
  }
  const insert = (schema: string, saleId: string, tenderType: string, amount: bigint, channel: string | null, cash: bigint | null) =>
    `INSERT INTO "${schema}".sale_tenders ("id", "saleId", "tenderType", "amount", "status", "mpesaChannel", "cashReceived")
     VALUES (gen_random_uuid(), '${saleId}', '${tenderType}', ${amount.toString()}, 'CONFIRMED', ${channel === null ? "NULL" : `'${channel}'`}, ${cash === null ? "NULL" : cash.toString()})`;

  it("a channel only on an M-Pesa tender; cash received only on cash, and covering it", async () => {
    const saleId = await aCashSale();
    await withTenantTx(A, async (client, schema) => {
      await expectDbRefusal(client.query(insert(schema, saleId, "CASH", 100n, "STK", null)), { constraint: "sale_tender_channel_only_mpesa" });
    });
    await withTenantTx(A, async (client, schema) => {
      await expectDbRefusal(client.query(insert(schema, saleId, "MPESA", 100n, null, 100n)), { constraint: "sale_tender_cash_received_covers_cash" });
    });
    await withTenantTx(A, async (client, schema) => {
      await expectDbRefusal(client.query(insert(schema, saleId, "CASH", 100n, null, 99n)), { constraint: "sale_tender_cash_received_covers_cash" });
    });
    // Control: the legal shapes are accepted.
    await withTenantTx(A, async (client, schema) => {
      await client.query(insert(schema, saleId, "CASH", 100n, null, 200n));
      await client.query(insert(schema, saleId, "MPESA", 100n, "TILL", null));
    });
  });

  it("both are write-once: no update transition", async () => {
    const saleId = await aCashSale();
    await withTenantTx(A, async (client, schema) => {
      const tender = await client.query<{ id: string }>(`SELECT id FROM "${schema}".sale_tenders WHERE "saleId" = $1`, [saleId]);
      const id = tender.rows[0]?.id ?? "";
      await expectDbRefusal(client.query(`UPDATE "${schema}".sale_tenders SET "cashReceived" = 100000 WHERE id = $1`, [id]), { fn: "sale_tender_guard_update" });
    });
    await withTenantTx(A, async (client, schema) => {
      const tender = await client.query<{ id: string }>(`SELECT id FROM "${schema}".sale_tenders WHERE "saleId" = $1`, [saleId]);
      await expectDbRefusal(client.query(`UPDATE "${schema}".sale_tenders SET "mpesaChannel" = 'STK' WHERE id = $1`, [tender.rows[0]?.id ?? ""]), { message: /immutable|sale_tender_channel_only_mpesa/ });
    });
  });
});
