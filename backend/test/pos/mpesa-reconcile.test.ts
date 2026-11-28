// ===========================================================================
// M-PESA WEBHOOK HARDENING + RECONCILIATION (M4.5 Wave 1, T-B2), through the REAL app and
// the simulated provider.
//
// * Concurrent duplicate callbacks are serialised by a row lock: exactly ONE confirmation
//   (and, on the legacy path, exactly one ledger entry), every request a clean 200.
// * A callback is ignored — no side effect — when its MerchantRequestID disagrees with the
//   push, or when its receipt already settles another transaction.
// * The source allowlist (MPESA_CALLBACK_IP_ALLOWLIST) answers a stranger with the bare 404.
// * Reconciliation asks the STK Query and resolves IDEMPOTENTLY: a definitive failure is
//   closed exactly once (legacy: one 1015 -> 1100 reversal); a "paid" answer is kept, never
//   timed out, and completed only with its receipt; running it again changes nothing.
// * The Daraja Timestamp is East Africa local time.
// * 0034's bookkeeping CHECK and query-count guard hold against raw SQL.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveTenantContext } from "../../src/auth/tenant-registry";
import { env } from "../../src/config/env";
import { platformDb } from "../../src/db/platform";
import { pool } from "../../src/db/pool";
import { buildServer } from "../../src/server";
import { recordStockMovement } from "../../src/services/inventory";
import { darajaTimestamp } from "../../src/services/mpesa/daraja-provider";
import {
  expireStalePending,
  initiatePreSaleStkPush,
  initiateStkPushForTender,
  reconcilePendingMpesa,
} from "../../src/services/mpesa/payment";
import { buildSimulatedCallbackEnvelope, setSimulatedQueryOutcome } from "../../src/services/mpesa/simulated-provider";
import { recordSale } from "../../src/services/sales";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { dropTenant, provisionFixture, schemaOf, tenantDb, tenantIdOf, withTenantTx } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { actorId, glNet, openTill, uniq } from "../support/fixtures";

const T = "qa-mpesa-rec";
const PHONE = "254712345678";

let app: FastifyInstance;
const users: StaffUser[] = [];
let manager: SignedIn;
let cashier: SignedIn;
let productId = "";

const webhookUrl = (): string => `/v1/webhooks/mpesa/${env.mpesa.callbackPathSecret}/${T}`;

async function context() {
  return resolveTenantContext(await tenantIdOf(T));
}

async function preSalePush(amountCents = 100000n) {
  return initiatePreSaleStkPush(tenantDb(T), { phoneNumber: PHONE, amountCents, createdBy: actorId(), tenant: await context() });
}

async function legacyPush(): Promise<{ checkoutRequestId: string; saleId: string }> {
  const db = tenantDb(T);
  const till = await openTill(db);
  const sale = await recordSale(db, { shiftId: till.shiftId, lines: [{ productId, quantity: "1" }], tenders: [{ tenderType: "MPESA", amount: "500.00" }], createdBy: till.cashierId });
  const tenderId = sale.tenders[0]?.id ?? "";
  const pushed = await initiateStkPushForTender(db, { saleId: sale.id, tenderId, phoneNumber: PHONE, createdBy: till.cashierId, tenant: await context() });
  return { checkoutRequestId: pushed.checkoutRequestId, saleId: sale.id };
}

async function txn(checkoutRequestId: string) {
  return tenantDb(T).mpesaTransaction.findUniqueOrThrow({ where: { checkoutRequestId } });
}

function envelopeFor(row: { merchantRequestId: string | null; checkoutRequestId: string; amount: bigint; phoneNumber: string }, outcome: "success" | "failure" = "success") {
  return buildSimulatedCallbackEnvelope(
    { merchantRequestId: row.merchantRequestId, checkoutRequestId: row.checkoutRequestId, amountCents: row.amount, phoneNumber: row.phoneNumber },
    outcome,
  );
}

function callback(payload: unknown) {
  return app.inject({ method: "POST", url: webhookUrl(), remoteAddress: freshIp(), payload: payload as Record<string, unknown> });
}

async function journalEntries(): Promise<number> {
  const rows = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${schemaOf(T)}".journal_entries`);
  return rows.rows[0]?.n ?? -1;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  await dropTenant(T);
  await provisionFixture(T, "QA M-Pesa Reconcile");
  const tenantId = await tenantIdOf(T);
  const managerUser = await createStaffUser("MSME_MANAGER", tenantId);
  const cashierUser = await createStaffUser("CASHIER", tenantId);
  users.push(managerUser, cashierUser);
  manager = await signIn(app, managerUser);
  cashier = await signIn(app, cashierUser);
  const db = tenantDb(T);
  const product = await db.product.create({ data: { sku: uniq("REC"), name: "Reconcile item", costPrice: 10000n, price: 50000n } });
  await recordStockMovement(db, { productId: product.id, movementType: "OPENING_BALANCE", quantity: "50", unitCost: 10000n, createdBy: actorId() });
  productId = product.id;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await platformDb.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await dropTenant(T);
  await app.close();
});

describe("the webhook, hardened", () => {
  it("serialises concurrent duplicate callbacks: one confirmation, two clean 200s (pre-sale)", async () => {
    const pushed = await preSalePush();
    const body = envelopeFor(await txn(pushed.checkoutRequestId));
    const [a, b] = await Promise.all([callback(body), callback(body)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const statuses = [a.json<{ status: string }>().status, b.json<{ status: string }>().status].sort();
    expect(statuses).toEqual(["already_processed", "confirmed"]);
    expect((await txn(pushed.checkoutRequestId)).status).toBe("CALLBACK_OK");
  });

  it("serialises concurrent duplicate callbacks on the legacy path: exactly ONE 1015 -> 1010 entry", async () => {
    const schema = schemaOf(T);
    const { checkoutRequestId } = await legacyPush();
    const till0 = await glNet(schema, "1010");
    const entries0 = await journalEntries();
    const body = envelopeFor(await txn(checkoutRequestId));
    const responses = await Promise.all([callback(body), callback(body), callback(body)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(responses.filter((response) => response.json<{ status: string }>().status === "confirmed")).toHaveLength(1);
    expect((await glNet(schema, "1010")) - till0).toBe(50000n);
    expect((await journalEntries()) - entries0).toBe(1);
  });

  it("ignores a callback whose MerchantRequestID is not the push's", async () => {
    const pushed = await preSalePush();
    const row = await txn(pushed.checkoutRequestId);
    const forged = envelopeFor({ ...row, merchantRequestId: "sim-mreq-not-this-push" });
    const response = await callback(forged);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe("ignored");
    expect((await txn(pushed.checkoutRequestId)).status).toBe("INITIATED");
  });

  it("ignores a receipt that already settles another transaction", async () => {
    const first = await preSalePush();
    const firstEnvelope = envelopeFor(await txn(first.checkoutRequestId));
    expect((await callback(firstEnvelope)).json<{ status: string }>().status).toBe("confirmed");
    const receipt = (await txn(first.checkoutRequestId)).mpesaReceiptNumber ?? "";

    const second = await preSalePush();
    const reused = envelopeFor(await txn(second.checkoutRequestId));
    const items = reused.Body.stkCallback.CallbackMetadata?.Item ?? [];
    for (const item of items) {
      if (item.Name === "MpesaReceiptNumber") item.Value = receipt;
    }
    const response = await callback(reused);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe("ignored");
    expect((await txn(second.checkoutRequestId)).status).toBe("INITIATED");
  });
});

describe("the callback source allowlist", () => {
  const saved = process.env["MPESA_CALLBACK_IP_ALLOWLIST"];
  let strict: FastifyInstance | null = null;

  afterEach(async () => {
    if (strict !== null) {
      await strict.close();
      strict = null;
    }
    if (saved === undefined) delete process.env["MPESA_CALLBACK_IP_ALLOWLIST"];
    else process.env["MPESA_CALLBACK_IP_ALLOWLIST"] = saved;
    vi.resetModules();
  });

  it("answers a sender outside the allowlist with the bare 404 (control: a listed sender is processed)", async () => {
    process.env["MPESA_CALLBACK_IP_ALLOWLIST"] = "196.201.214.0/24, 196.201.213.114";
    vi.resetModules();
    const fresh = await import("../../src/server");
    strict = await fresh.buildServer();
    await strict.ready();
    const body = { Body: { stkCallback: { CheckoutRequestID: "ws_CO_unknown", ResultCode: 0 } } };
    const stranger = await strict.inject({ method: "POST", url: webhookUrl(), remoteAddress: "10.9.9.9", payload: body });
    expect(stranger.statusCode).toBe(404);
    expect(stranger.json()).toEqual({ error: "Not found" });
    // Even a malformed body from a stranger is the same 404 (the gate runs before validation).
    const malformed = await strict.inject({ method: "POST", url: webhookUrl(), remoteAddress: "10.9.9.9", payload: { nonsense: true } });
    expect(malformed.statusCode).toBe(404);
    const listed = await strict.inject({ method: "POST", url: webhookUrl(), remoteAddress: "196.201.214.7", payload: body });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ status: string }>().status).toBe("ignored");
    const exact = await strict.inject({ method: "POST", url: webhookUrl(), remoteAddress: "196.201.213.114", payload: body });
    expect(exact.statusCode).toBe(200);
  });
});

describe("reconciliation by STK query", () => {
  it("resolves definitive failures once, keeps a paid push, leaves a pending one — and is idempotent", async () => {
    const schema = schemaOf(T);
    // Clear the deck: earlier pushes in this file are someone else's story.
    await reconcilePendingMpesa(tenantDb(T), await context(), { olderThanMinutes: 0 });

    const failedPreSale = await preSalePush();
    const paidPreSale = await preSalePush();
    const pendingPreSale = await preSalePush();
    const failedLegacy = await legacyPush();
    setSimulatedQueryOutcome(failedPreSale.checkoutRequestId, "FAILED");
    setSimulatedQueryOutcome(paidPreSale.checkoutRequestId, "SUCCESS");
    setSimulatedQueryOutcome(failedLegacy.checkoutRequestId, "FAILED");

    const ar0 = await glNet(schema, "1100");
    const entries0 = await journalEntries();
    const first = await app.inject({ method: "POST", url: "/v1/pos/mpesa/reconcile", headers: bearer(manager.token), payload: { olderThanMinutes: 0 } });
    expect(first.statusCode, first.body).toBe(200);
    const results = new Map(first.json<{ outcomes: Array<{ checkoutRequestId: string; result: string }> }>().outcomes.map((o) => [o.checkoutRequestId, o.result]));
    expect(results.get(failedPreSale.checkoutRequestId)).toBe("RESOLVED_FAILED");
    expect(results.get(paidPreSale.checkoutRequestId)).toBe("PAID_AWAITING_RECEIPT");
    expect(results.get(pendingPreSale.checkoutRequestId)).toBe("STILL_PENDING");
    expect(results.get(failedLegacy.checkoutRequestId)).toBe("RESOLVED_FAILED");

    expect((await txn(failedPreSale.checkoutRequestId)).status).toBe("CALLBACK_FAILED");
    expect((await txn(failedLegacy.checkoutRequestId)).status).toBe("CALLBACK_FAILED");
    const paid = await txn(paidPreSale.checkoutRequestId);
    expect(paid.status).toBe("INITIATED");
    expect(paid.queryResultCode).toBe(0);
    // Exactly one ledger effect: the legacy reversal 1015 -> 1100 (pre-sale pushes post nothing).
    expect((await journalEntries()) - entries0).toBe(1);
    expect((await glNet(schema, "1100")) - ar0).toBe(50000n);

    // AGAIN: nothing new is resolved, nothing is posted, the paid push is not re-asked.
    const second = await app.inject({ method: "POST", url: "/v1/pos/mpesa/reconcile", headers: bearer(manager.token), payload: { olderThanMinutes: 0 } });
    const mine = new Set([failedPreSale, paidPreSale, pendingPreSale, failedLegacy].map((push) => push.checkoutRequestId));
    const again = second.json<{ outcomes: Array<{ checkoutRequestId: string; result: string }> }>().outcomes.filter((o) => mine.has(o.checkoutRequestId));
    expect(again.map((o) => o.checkoutRequestId)).toEqual([pendingPreSale.checkoutRequestId]);
    expect((await journalEntries()) - entries0).toBe(1);
    expect((await txn(pendingPreSale.checkoutRequestId)).queryCount).toBe(2);
    expect((await txn(paidPreSale.checkoutRequestId)).queryCount).toBe(1);

    // A late callback for an already-reconciled failure is a no-op.
    const late = await callback(envelopeFor(await txn(failedLegacy.checkoutRequestId)));
    expect(late.json<{ status: string }>().status).toBe("already_processed");
    expect((await journalEntries()) - entries0).toBe(1);

    // The timeout sweep NEVER times out a push Safaricom says was paid.
    await expireStalePending(tenantDb(T), 0);
    expect((await txn(paidPreSale.checkoutRequestId)).status).toBe("INITIATED");
    expect((await txn(pendingPreSale.checkoutRequestId)).status).toBe("TIMED_OUT");

    // Completing the paid push needs its receipt, once.
    const resolveUrl = `/v1/pos/mpesa/${paidPreSale.checkoutRequestId}/resolve`;
    const done = await app.inject({ method: "POST", url: resolveUrl, headers: bearer(manager.token), payload: { receipt: "RECON12345" } });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toEqual({ status: "confirmed" });
    const resolved = await txn(paidPreSale.checkoutRequestId);
    expect(resolved.status).toBe("CALLBACK_OK");
    expect(resolved.mpesaReceiptNumber).toBe("RECON12345");
    const repeat = await app.inject({ method: "POST", url: resolveUrl, headers: bearer(manager.token), payload: { receipt: "RECON12345" } });
    expect(repeat.json()).toEqual({ status: "already_processed" });
  });

  it("refuses to complete a push the query did not confirm, or with a receipt already used", async () => {
    const unconfirmed = await preSalePush();
    const refused = await app.inject({ method: "POST", url: `/v1/pos/mpesa/${unconfirmed.checkoutRequestId}/resolve`, headers: bearer(manager.token), payload: { receipt: "NOTPAID123" } });
    expect(refused.statusCode).toBe(409);
    expect((await txn(unconfirmed.checkoutRequestId)).status).toBe("INITIATED");

    const paidA = await preSalePush();
    const paidB = await preSalePush();
    setSimulatedQueryOutcome(paidA.checkoutRequestId, "SUCCESS");
    setSimulatedQueryOutcome(paidB.checkoutRequestId, "SUCCESS");
    await reconcilePendingMpesa(tenantDb(T), await context(), { olderThanMinutes: 0 });
    const ok = await app.inject({ method: "POST", url: `/v1/pos/mpesa/${paidA.checkoutRequestId}/resolve`, headers: bearer(manager.token), payload: { receipt: "ONCEONLY77" } });
    expect(ok.statusCode).toBe(200);
    const reused = await app.inject({ method: "POST", url: `/v1/pos/mpesa/${paidB.checkoutRequestId}/resolve`, headers: bearer(manager.token), payload: { receipt: "ONCEONLY77" } });
    expect(reused.statusCode).toBe(409);
    expect((await txn(paidB.checkoutRequestId)).status).toBe("INITIATED");
  });

  it("is for the owner and manager — a cashier is refused", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/pos/mpesa/reconcile", headers: bearer(cashier.token), payload: {} });
    expect(response.statusCode).toBe(403);
  });
});

describe("the Daraja Timestamp is East Africa local time (resolves the H.1 watch item)", () => {
  it("formats 22:30:05 UTC on 31 October as 01:30:05 on 1 November", () => {
    expect(darajaTimestamp(new Date("2026-10-31T22:30:05.000Z"))).toBe("20261101013005");
    expect(darajaTimestamp(new Date("2026-11-15T09:00:00.000Z"))).toBe("20261115120000");
  });
});

describe("migration 0034, attacked from raw SQL", () => {
  it("refuses incoherent query bookkeeping and a falling query count (control: a legal record)", async () => {
    const pushed = await preSalePush();
    const id = (await txn(pushed.checkoutRequestId)).id;
    await withTenantTx(T, async (client, schema) => {
      await expectDbRefusal(client.query(`UPDATE "${schema}".mpesa_transactions SET "queryResultCode" = 0 WHERE "id" = $1`, [id]), {
        constraint: "mpesa_query_bookkeeping_coherent",
        code: "23514",
      });
    });
    await withTenantTx(T, async (client, schema) => {
      await client.query(`UPDATE "${schema}".mpesa_transactions SET "queryCount" = 2, "lastQueriedAt" = now() WHERE "id" = $1`, [id]);
      await expectDbRefusal(client.query(`UPDATE "${schema}".mpesa_transactions SET "queryCount" = 1 WHERE "id" = $1`, [id]), {
        fn: "mpesa_txn_query_guard",
        message: /can only rise/,
      });
    });
  });
});
