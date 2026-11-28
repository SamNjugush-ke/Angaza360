// T-B-PO-GRN-LIST and T-B-PO-LINE-BILLEDQTY: a purchase order's goods receipts read directly (no
// longer derived from stock movements), and each order line's billed / received-not-yet-billed
// quantity — where a new supplier bill against it starts.

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server";
import { createSupplierBill, postSupplierBill } from "../../src/services/payables";
import { approvePurchaseOrder, createPurchaseOrder, getPurchaseOrder, listGoodsReceiptsForOrder, receivePurchaseOrder } from "../../src/services/procurement";
import { tenantDb, tenantIdOf } from "../setup/tenant";
import { actorId, createProduct, createSupplier, receiveStock } from "../support/fixtures";
import { bearer, createStaffUser, signIn } from "../identity/staff-fixture";
import { platformDb } from "../../src/db/platform";

let app: FastifyInstance;
let orderId = "";
let lineId = "";
const grnIds: string[] = [];
const made: string[] = [];

beforeAll(async () => {
  const db = tenantDb();
  const supplierId = await createSupplier(db);
  const productId = await createProduct(db, { price: 100000n, taxClass: "ZERO_RATED" });
  const draft = await createPurchaseOrder(db, { supplierId, orderDate: new Date(), lines: [{ productId, quantity: "10", unitCost: 25000n }], createdById: actorId() });
  const approved = await approvePurchaseOrder(db, draft.id, actorId());
  orderId = approved.id;
  lineId = approved.lines[0]?.id ?? "";
  // Two deliveries, and a bill for the first one only.
  const first = await receivePurchaseOrder(db, orderId, { lines: [{ purchaseOrderLineId: lineId, quantity: "4" }], receivedById: actorId() });
  grnIds.push(first.id);
  const bill = await createSupplierBill(db, {
    supplierId,
    billNumber: `INV-RD-${approved.poNumber.toString()}`,
    poId: orderId,
    billDate: new Date(),
    lines: [{ description: "first delivery", quantity: "4", unitCost: 25000n, purchaseOrderLineId: lineId }],
    createdById: actorId(),
  });
  await postSupplierBill(db, bill.id, actorId());
  const second = await receivePurchaseOrder(db, orderId, { lines: [{ purchaseOrderLineId: lineId, quantity: "6" }], receivedById: actorId() });
  grnIds.push(second.id);
  // Another order's receipt, which must never show up under this one.
  await receiveStock(db, supplierId, [{ productId, quantity: "2", unitCost: 25000n }]);
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await platformDb.user.deleteMany({ where: { id: { in: made } } });
  await app.close();
});

describe("a purchase order's goods receipts", () => {
  it("lists every GRN of the order, oldest first, with its lines and accrual", async () => {
    const grns = await listGoodsReceiptsForOrder(tenantDb(), orderId);
    expect(grns?.map((g) => g.id)).toEqual(grnIds);
    expect(grns?.map((g) => g.lines.map((l) => l.quantity))).toEqual([["4.000"], ["6.000"]]);
    expect(grns?.map((g) => g.totalAccrued)).toEqual([100000n, 150000n]);
    expect(await listGoodsReceiptsForOrder(tenantDb(), "no-such-order")).toBeNull();
  });

  it("is a read route for the order's readers; an unknown order is a 404", async () => {
    const accountant = await createStaffUser("ACCOUNTANT", await tenantIdOf());
    made.push(accountant.id);
    const { token } = await signIn(app, accountant);
    const ok = await app.inject({ method: "GET", url: `/v1/procurement/purchase-orders/${orderId}/goods-receipts`, headers: bearer(token) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ data: Array<{ grnNumber: number; totalAccrued: string }> }>().data.map((g) => g.totalAccrued)).toEqual(["100000", "150000"]);
    const missing = await app.inject({ method: "GET", url: "/v1/procurement/purchase-orders/no-such-order/goods-receipts", headers: bearer(token) });
    expect(missing.statusCode).toBe(404);
  });
});

describe("billed and unbilled quantity on a purchase-order line", () => {
  it("says how much has been billed and how much was received but not yet billed", async () => {
    const order = await getPurchaseOrder(tenantDb(), orderId);
    const line = order?.lines.find((l) => l.id === lineId);
    expect(line).toMatchObject({ orderedQty: "10.000", receivedQty: "10.000", billedQty: "4.000", unbilledQty: "6.000", outstandingQty: "0.000" });
  });
});
