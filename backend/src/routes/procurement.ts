// ===========================================================================
// Procurement routes — purchase orders and goods receipts (Module 4, Task 5.1).
//
// These routes authorise and delegate. All purchase-order and goods-receipt state
// goes through src/services/procurement.ts; every stock movement and every journal
// entry goes through src/services/inventory.ts's transaction-participating mover.
// No route here writes a stock table and none posts to the ledger.
//
// Money is cents as STRINGS in and out; quantities are decimal strings. A JSON
// number in a money field is rejected by the schema, because a number can lose
// precision before it ever reaches us.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { parseMoneyToCents } from "../lib/money";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  getGoodsReceipt,
  getPurchaseOrder,
  listPurchaseOrders,
  receivePurchaseOrder,
  updatePurchaseOrder,
  ProcurementStateError,
  ProcurementValidationError,
  type PurchaseOrderLineInput,
} from "../services/procurement";
import { InsufficientStockError, InventoryValidationError } from "../services/inventory";
import { LedgerValidationError, PeriodClosedError } from "../services/ledger";
import { zGoodsReceipt, zPurchaseOrder, zPurchaseOrderStatus } from "../schemas/models";
import {
  badRequest,
  conflict,
  errorBody,
  errorResponses,
  isoDateToUtc,
  notFound,
  SECURE,
  zIdParam,
  zIsoDate,
  zMoneyNonNegative,
  zQuantityPositive,
} from "../schemas/common";

const zLineBody = z.object({
  productId: z.string().min(1, "productId is required."),
  quantity: zQuantityPositive,
  unitCost: zMoneyNonNegative.meta({
    description:
      "Cost per unit as a decimal money string. **Its meaning depends on the tenant's VAT status**: the NET cost for a VAT-registered tenant (input VAT is recoverable, so it is not part of the asset's cost), the VAT-INCLUSIVE cost for a non-registered one (the tax is never coming back, so it IS part of what the goods cost). In both cases this is exactly what reaches account 1200 on receipt.",
  }),
});

const zCreateBody = z.object({
  supplierId: z.string().min(1, "supplierId is required."),
  orderDate: zIsoDate,
  expectedDate: zIsoDate.optional(),
  notes: z.string().min(1).optional(),
  lines: z.array(zLineBody).min(1, "A purchase order needs at least one line."),
});

const zUpdateBody = z.object({
  supplierId: z.string().min(1).optional(),
  orderDate: zIsoDate.optional(),
  expectedDate: zIsoDate.nullable().optional(),
  notes: z.string().nullable().optional(),
  lines: z.array(zLineBody).min(1).optional().meta({
    description:
      "Supplied: the line set is REPLACED wholesale. Omitted: lines are left untouched. Replacement rather than merge is deliberate — a partial merge would need a per-line identity the client does not have, and guessing one silently drops a quantity change. A DRAFT has no received quantities to preserve.",
  }),
});

const zReceiveBody = z.object({
  receivingLocationId: z.string().min(1).optional().meta({
    description:
      "Where the goods land. Omit for the tenant's MAIN pool — the same defaulting the sale path uses for its selling location, so stock always arrives somewhere specific and the location-ownership rules apply from the moment it lands.",
  }),
  receivedAt: zIsoDate.optional().meta({
    description: "The date the goods arrived. Defaults to today. The journal entry is dated to it.",
  }),
  notes: z.string().min(1).optional(),
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: z.string().min(1, "purchaseOrderLineId is required."),
        quantity: zQuantityPositive,
      }),
    )
    .min(1, "A goods receipt needs at least one line."),
});

// State-dependent rules — is this order still a DRAFT, does the line still expect
// this quantity, is the period open — depend on rows in the database rather than on
// the shape of the request, so they stay in the services and surface here.
function sendProcurementError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ProcurementStateError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof PeriodClosedError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (
    error instanceof ProcurementValidationError ||
    error instanceof InventoryValidationError ||
    error instanceof InsufficientStockError ||
    error instanceof LedgerValidationError
  ) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

function buildLines(raw: ReadonlyArray<z.infer<typeof zLineBody>>): PurchaseOrderLineInput[] {
  return raw.map((line) => ({
    productId: line.productId,
    quantity: line.quantity.trim(),
    unitCost: parseMoneyToCents(line.unitCost),
  }));
}

/** A validated YYYY-MM-DD is already known to parse; this keeps the type honest. */
function requireDate(value: string, field: string): Date {
  const parsed = isoDateToUtc(value);
  if (parsed === null) {
    throw new ProcurementValidationError(`${field} must be YYYY-MM-DD.`);
  }
  return parsed;
}

export async function procurementRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];

  // Raising and receiving a purchase order is stock work: the SAME roles that may
  // book an inventory receipt today (src/routes/inventory.ts stockWriteRoles), so
  // the person who can record goods arriving can do it with or without a PO.
  const procureRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF");
  // Approving commits the business to a supplier and cancelling withdraws that
  // commitment. Both are administrative, like deciding an allocation request.
  const approveRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER");
  const readRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "WAREHOUSE_STAFF",
    "ACCOUNTANT",
    "VIEWER_AUDITOR",
  );

  // --- Purchase orders -----------------------------------------------------

  api.route({
    method: "POST",
    url: "/purchase-orders",
    preHandler: [...base, procureRoles],
    schema: {
      tags: ["Procurement"],
      summary: "Raise a DRAFT purchase order",
      description:
        "**A DRAFT HAS NO FINANCIAL EFFECT WHATSOEVER** — no journal entry, no stock movement, nothing committed anywhere but the order itself. An intention to buy is not a transaction.\n\n" +
        "Each line is priced as quantity x unitCost, rounded once through the same primitive the sale path and every receipt use, so a line's value and the receipt's value agree to the cent. One line per product per order, so \"how much of this have we received\" has a single answer.",
      security: SECURE,
      body: zCreateBody,
      response: { 201: zPurchaseOrder, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      try {
        const created = await createPurchaseOrder(request.tenantDb, {
          supplierId: body.supplierId,
          orderDate: requireDate(body.orderDate, "orderDate"),
          ...(body.expectedDate !== undefined
            ? { expectedDate: requireDate(body.expectedDate, "expectedDate") }
            : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          lines: buildLines(body.lines),
          createdById: auth.userId,
        });
        return reply.code(201).send(created);
      } catch (error) {
        return sendProcurementError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/purchase-orders",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Procurement"],
      summary: "List purchase orders",
      description:
        "Newest order number first. Filter by status (`APPROVED` and `PARTIALLY_RECEIVED` together are the orders goods can still be received against) or by supplier.",
      security: SECURE,
      querystring: z.object({
        status: zPurchaseOrderStatus.optional(),
        supplierId: z.string().min(1).optional(),
      }),
      response: {
        200: z.object({ data: z.array(zPurchaseOrder), count: z.number().int() }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { status, supplierId } = request.query;
      const data = await listPurchaseOrders(request.tenantDb, {
        ...(status !== undefined ? { status } : {}),
        ...(supplierId !== undefined ? { supplierId } : {}),
      });
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/purchase-orders/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Procurement"],
      summary: "Get one purchase order with its lines and received quantities",
      security: SECURE,
      params: zIdParam,
      response: { 200: zPurchaseOrder, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const order = await getPurchaseOrder(request.tenantDb, request.params.id);
      if (order === null) {
        return reply.code(404).send(notFound(`No purchase order with id "${request.params.id}".`));
      }
      return reply.code(200).send(order);
    },
  });

  api.route({
    method: "PATCH",
    url: "/purchase-orders/:id",
    preHandler: [...base, procureRoles],
    schema: {
      tags: ["Procurement"],
      summary: "Edit a DRAFT purchase order",
      description:
        "**409 once the order leaves DRAFT**, and a database trigger refuses it too. Once an order is APPROVED the SUPPLIER HOLDS A COPY: changing our side of a shared agreement without them does not produce an edited order, it produces a discrepancy that surfaces when the invoice disagrees with the PO.",
      security: SECURE,
      params: zIdParam,
      body: zUpdateBody,
      response: { 200: zPurchaseOrder, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const body = request.body;
      try {
        const updated = await updatePurchaseOrder(request.tenantDb, request.params.id, {
          ...(body.supplierId !== undefined ? { supplierId: body.supplierId } : {}),
          ...(body.orderDate !== undefined
            ? { orderDate: requireDate(body.orderDate, "orderDate") }
            : {}),
          ...(body.expectedDate !== undefined
            ? {
                expectedDate:
                  body.expectedDate === null
                    ? null
                    : requireDate(body.expectedDate, "expectedDate"),
              }
            : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.lines !== undefined ? { lines: buildLines(body.lines) } : {}),
        });
        return reply.code(200).send(updated);
      } catch (error) {
        return sendNotFoundOrError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/purchase-orders/:id/approve",
    preHandler: [...base, approveRoles],
    schema: {
      tags: ["Procurement"],
      summary: "Approve a DRAFT purchase order",
      description:
        "The order is now committed to the supplier and may be received against. **It still posts nothing** — a commitment to buy is not a transaction, and nothing reaches the ledger until goods actually arrive.\n\n" +
        "Single-step approval. Multi-level approval and budget checks are deferred; when they arrive they add rows and a policy read, not a change to this transition. Who approved it and when are recorded together and are then immutable.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zPurchaseOrder, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const approved = await approvePurchaseOrder(
          request.tenantDb,
          request.params.id,
          auth.userId,
        );
        return reply.code(200).send(approved);
      } catch (error) {
        return sendNotFoundOrError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/purchase-orders/:id/cancel",
    preHandler: [...base, approveRoles],
    schema: {
      tags: ["Procurement"],
      summary: "Cancel a purchase order that never happened",
      description:
        "Permitted from DRAFT and APPROVED only.\n\n" +
        "**409 once anything has been received.** At that point the order DID happen: value has been accrued to 2050 GRNI and the supplier will still invoice it, so cancelling would orphan a liability. Such an order is CLOSED short instead, which says \"we are finished with this\" without claiming it never occurred.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zPurchaseOrder, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      try {
        const cancelled = await cancelPurchaseOrder(request.tenantDb, request.params.id);
        return reply.code(200).send(cancelled);
      } catch (error) {
        return sendNotFoundOrError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/purchase-orders/:id/close",
    preHandler: [...base, approveRoles],
    schema: {
      tags: ["Procurement"],
      summary: "Close a received or partially-received order",
      description:
        "Terminal. The way to finish with an order that was only partly delivered and will not be completed — the receipts that did happen stand, and their GRNI accrual still awaits its supplier bill. An order with nothing received is CANCELLED instead.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zPurchaseOrder, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      try {
        const closed = await closePurchaseOrder(request.tenantDb, request.params.id);
        return reply.code(200).send(closed);
      } catch (error) {
        return sendNotFoundOrError(reply, error);
      }
    },
  });

  // --- Receiving -----------------------------------------------------------

  api.route({
    method: "POST",
    url: "/purchase-orders/:id/receive",
    preHandler: [...base, procureRoles],
    schema: {
      tags: ["Procurement"],
      summary: "Receive goods against a purchase order (creates a GRN)",
      description:
        "**ONE TRANSACTION, ALL OF IT:** the goods receipt, every line's stock movement, the journal entry, each line's received quantity, and the order's new status. Either all of it commits or none of it does.\n\n" +
        "**THE POSTING.** Goods arrive with a DELIVERY NOTE, not a tax invoice — so there is no invoiced amount for Accounts Payable and nothing to claim input VAT with. The receipt therefore accrues to GRNI:\n\n" +
        "* `Dr 1200 Inventory` / `Cr 2050 GRNI` — at the NET cost for a VAT-registered tenant, at the VAT-INCLUSIVE cost for a non-registered one.\n" +
        "* **No VAT is recognised here.** It is recognised when the supplier's bill is booked (Task 5.2), which also clears GRNI to Accounts Payable and posts any difference between the PO price and the invoiced price to 5250 Purchase Price Variance.\n\n" +
        "Stock and valuation go through the same mover every other stock event uses, so weighted-average cost, the location-ownership check and the `stockCount = SUM(per-location quantity)` invariant all apply unchanged.\n\n" +
        "**409** unless the order is APPROVED or PARTIALLY_RECEIVED. **400** on an over-receipt, naming the line and what it still expects — a database CHECK refuses it too, because receiving more than was ordered would accrue a liability for goods nobody ordered.",
      security: SECURE,
      params: zIdParam,
      body: zReceiveBody,
      response: { 201: zGoodsReceipt, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      try {
        const grn = await receivePurchaseOrder(request.tenantDb, request.params.id, {
          lines: body.lines.map((line) => ({
            purchaseOrderLineId: line.purchaseOrderLineId,
            quantity: line.quantity.trim(),
          })),
          ...(body.receivingLocationId !== undefined
            ? { receivingLocationId: body.receivingLocationId }
            : {}),
          ...(body.receivedAt !== undefined
            ? { receivedAt: requireDate(body.receivedAt, "receivedAt") }
            : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          receivedById: auth.userId,
        });
        return reply.code(201).send(grn);
      } catch (error) {
        return sendNotFoundOrError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/goods-receipts/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Procurement"],
      summary: "Get a goods receipt with its lines and postings",
      description:
        "A GRN is an IMMUTABLE posted fact — the database refuses both UPDATE and DELETE on it. Each line names the stock movement and the journal entry it produced, and `totalAccrued` is what this receipt added to 2050 GRNI.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zGoodsReceipt, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const grn = await getGoodsReceipt(request.tenantDb, request.params.id);
      if (grn === null) {
        return reply.code(404).send(notFound(`No goods receipt with id "${request.params.id}".`));
      }
      return reply.code(200).send(grn);
    },
  });
}

/**
 * "Unknown purchase order" is a 404, not a 400: the caller named something that
 * does not exist in THIS tenant's schema, which is also how cross-tenant access
 * presents — a Thika session asking for a Nakuru order simply finds nothing.
 */
function sendNotFoundOrError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof ProcurementValidationError &&
    /^Unknown (purchase order|goods receipt)/.test(error.message)
  ) {
    return reply.code(404).send(notFound(error.message));
  }
  return sendProcurementError(reply, error);
}
