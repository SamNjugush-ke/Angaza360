// ===========================================================================
// A VOID'S CASH REFUND IS BOOKED AGAINST THE DRAWER IT LEFT (Task T-B-SHIFT-VOID, migration 0030).
//
// expectedCash(S) = openingFloat + cash TAKEN on every sale rung in S (completed or voided)
//                                 − cash REFUNDED for voids booked against S (Sale.voidShiftId)
// * a ring-then-void in the same shift nets to ZERO (it used to count the money out twice);
// * a void of an earlier shift's sale subtracts ONLY in the shift whose drawer paid it, and the
//   earlier shift's settled count is untouched;
// * a normal close is unchanged;
// * the database holds the drawer: it must be OPEN when the void books it, and it is frozen after.
// ===========================================================================

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { closeShift, openShift } from "../../src/services/shifts";
import { recordSale, voidSale } from "../../src/services/sales";
import { tenantDb, withTenantTx } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { actorId, uniq } from "../support/fixtures";

const db = tenantDb();
let serviceId = "";

// A service product: no stock to arrange. The fixture is VAT-registered, so 100.00 sells at 116.00.
beforeAll(async () => {
  const product = await db.product.create({ data: { sku: uniq("SVC-VOID"), name: uniq("Service"), costPrice: 0n, price: 10000n, kind: "SERVICE" } });
  serviceId = product.id;
});

const cashier = () => randomUUID();

async function cashSale(shiftId: string, cashierId: string): Promise<string> {
  const sale = await recordSale(db, {
    shiftId,
    createdBy: cashierId,
    lines: [{ productId: serviceId, quantity: "1" }],
    tenders: [{ tenderType: "CASH", amount: "116.00" }],
  });
  return sale.id;
}

describe("a shift's expected cash", () => {
  it("is unchanged for a normal close: float + the cash taken", async () => {
    const who = cashier();
    const shift = await openShift(db, who, 5000n);
    await cashSale(shift.id, who);
    await cashSale(shift.id, who);
    const closed = await closeShift(db, shift.id, 5000n + 23200n, who);
    expect(closed).toMatchObject({ expectedCash: 28200n, variance: 0n });
  });

  it("nets a same-shift ring-then-void to ZERO", async () => {
    const who = cashier();
    const shift = await openShift(db, who, 0n);
    const saleId = await cashSale(shift.id, who);
    await voidSale(db, saleId, "Rung by mistake", actorId()); // a manager voids at the till
    const sale = await db.sale.findUniqueOrThrow({ where: { id: saleId } });
    expect(sale.voidShiftId).toBe(shift.id); // booked against its own, still-open shift
    const closed = await closeShift(db, shift.id, 0n, who);
    expect(closed).toMatchObject({ expectedCash: 0n, variance: 0n });
  });

  it("subtracts an earlier shift's refund ONLY in the drawer that paid it", async () => {
    const morning = cashier();
    const shiftA = await openShift(db, morning, 0n);
    const saleId = await cashSale(shiftA.id, morning);
    const closedA = await closeShift(db, shiftA.id, 11600n, morning);
    expect(closedA).toMatchObject({ expectedCash: 11600n, variance: 0n });

    const evening = cashier();
    const shiftB = await openShift(db, evening, 20000n);
    // The customer comes back in the evening: the refund leaves the evening drawer.
    await voidSale(db, saleId, "Returned after close", actorId(), { shiftId: shiftB.id });
    expect((await db.sale.findUniqueOrThrow({ where: { id: saleId } })).voidShiftId).toBe(shiftB.id);
    const closedB = await closeShift(db, shiftB.id, 8400n, evening);
    expect(closedB).toMatchObject({ expectedCash: 8400n, variance: 0n }); // 200.00 float − 116.00 refunded
    // The morning shift's settled count is untouched.
    expect((await db.shift.findUniqueOrThrow({ where: { id: shiftA.id } })).expectedCash).toBe(11600n);
  });

  it("books a refund against the VOIDER's own open shift when none is named", async () => {
    const morning = cashier();
    const shiftA = await openShift(db, morning, 0n);
    const saleId = await cashSale(shiftA.id, morning);
    await closeShift(db, shiftA.id, 11600n, morning);
    const evening = cashier();
    const shiftB = await openShift(db, evening, 0n);
    await voidSale(db, saleId, "Returned", evening);
    expect((await db.sale.findUniqueOrThrow({ where: { id: saleId } })).voidShiftId).toBe(shiftB.id);
    await closeShift(db, shiftB.id, 0n, evening);
  });

  it("refuses a cash refund with no open till to pay it — rather than guessing a drawer", async () => {
    const who = cashier();
    const shift = await openShift(db, who, 0n);
    const saleId = await cashSale(shift.id, who);
    await closeShift(db, shift.id, 11600n, who);
    await expect(voidSale(db, saleId, "No till", actorId())).rejects.toThrow(/open till/);
    await expect(voidSale(db, saleId, "Closed till", actorId(), { shiftId: shift.id })).rejects.toThrow(/closed/);
    expect((await db.sale.findUniqueOrThrow({ where: { id: saleId } })).status).toBe("COMPLETED");
  });
});

describe("the database holds the drawer (migration 0030)", () => {
  async function voidedSaleAndShifts() {
    const who = cashier();
    const open = await openShift(db, who, 0n);
    const saleId = await cashSale(open.id, who);
    await voidSale(db, saleId, "For the guard test", actorId());
    const other = cashier();
    const closed = await openShift(db, other, 0n);
    await closeShift(db, closed.id, 0n, other);
    return { saleId, openId: open.id, closedId: closed.id };
  }

  it("freezes voidShiftId once the void is booked — even to another open shift", async () => {
    const { saleId } = await voidedSaleAndShifts();
    const another = await openShift(db, cashier(), 0n);
    await withTenantTx("qa-fixture", async (client, schema) => {
      await expectDbRefusal(client.query(`UPDATE "${schema}".sales SET "voidShiftId" = $1 WHERE id = $2`, [another.id, saleId]), {
        fn: "sale_guard_update",
        message: /void fields may only change/,
      });
    });
  });

  it("refuses a void booked against a CLOSED shift; accepts an open one (the control)", async () => {
    const who = cashier();
    const open = await openShift(db, who, 0n);
    const saleId = await cashSale(open.id, who);
    const other = cashier();
    const closed = await openShift(db, other, 0n);
    await closeShift(db, closed.id, 0n, other);
    const sale = await db.sale.findUniqueOrThrow({ where: { id: saleId } });
    await withTenantTx("qa-fixture", async (client, schema) => {
      // A reversing entry to point at: the sale's own revenue entry id is unique-safe only once,
      // so borrow a fresh UUID-shaped marker — the guard rejects before any FK is considered.
      const marker = randomUUID();
      await client.query("SAVEPOINT s");
      await expectDbRefusal(
        client.query(`UPDATE "${schema}".sales SET status = 'VOIDED', "voidedByEntryId" = $1, "voidReason" = 'x', "voidShiftId" = $2 WHERE id = $3`, [marker, closed.id, sale.id]),
        { fn: "sale_guard_update", message: /OPEN shift/ },
      );
      await client.query("ROLLBACK TO SAVEPOINT s");
      await expectDbRefusal(
        client.query(`UPDATE "${schema}".sales SET status = 'VOIDED', "voidedByEntryId" = $1, "voidReason" = 'x', "voidShiftId" = $2 WHERE id = $3`, [marker, randomUUID(), sale.id]),
        { fn: "sale_guard_update", message: /OPEN shift/ },
      );
    });
    // The control: the service books it against the open shift.
    await voidSale(db, saleId, "Control", actorId(), { shiftId: open.id });
    expect((await db.sale.findUniqueOrThrow({ where: { id: saleId } })).voidShiftId).toBe(open.id);
  });

  it("allows a drawer only on a voided sale (CHECK)", async () => {
    const who = cashier();
    const open = await openShift(db, who, 0n);
    const saleId = await cashSale(open.id, who);
    await withTenantTx("qa-fixture", async (client, schema) => {
      // With the triggers suspended (rolled back), the CHECK alone still refuses it.
      await client.query("SET LOCAL session_replication_role = replica");
      await expectDbRefusal(client.query(`UPDATE "${schema}".sales SET "voidShiftId" = $1 WHERE id = $2`, [open.id, saleId]), {
        constraint: "sale_void_shift_only_when_voided",
      });
    });
  });
});
