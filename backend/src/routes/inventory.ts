import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { parseMoneyToCents } from "../lib/money";
import {
  recordStockMovement,
  getStockLevels,
  getMovementHistory,
  getInventoryValuation,
  getStockByLocation,
  getLocationStock,
  getProductLocationSplit,
  transferStock,
  InventoryValidationError,
  InsufficientStockError,
  type RecordStockMovementInput,
} from "../services/inventory";
import { PeriodClosedError, LedgerValidationError } from "../services/ledger";
import { listLocations } from "../services/locations";
import {
  zLocation,
  zMovementHistoryRow,
  zStockLevelRow,
  zStockMovementResult,
  zSupplier,
} from "../schemas/models";
import {
  badRequest,
  conflict,
  errorBody,
  errorResponses,
  isoDateToUtc,
  notFound,
  SECURE,
  businessTodayDate,
  zCentsString,
  zDecimalString,
  zIdParam,
  zIsoDate,
  zMoneyNonNegative,
  zPaginationResult,
  zPaginationWithDefault,
  zQuantityPositive,
  zTimestamp,
} from "../schemas/common";

// All stock mutation goes through src/services/inventory.ts; these routes
// authorise and delegate. Money and quantities arrive as decimal STRINGS — a
// JSON number is rejected by the schema, since a number can silently lose
// precision.

const zReceiptBody = z.object({
  productId: z.string().min(1, "productId is required."),
  quantity: zQuantityPositive,
  unitCost: zMoneyNonNegative,
  supplierId: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  paidImmediately: z.boolean().optional().meta({
    description:
      "true settles the purchase against cash immediately; false (default) posts it to Accounts Payable.",
  }),
});

const zAdjustmentBody = z.object({
  productId: z.string().min(1, "productId is required."),
  movementType: z.enum(["ADJUSTMENT_INCREASE", "ADJUSTMENT_DECREASE"]),
  quantity: zQuantityPositive,
  // Required only for an INCREASE — see the cross-field note in the handler.
  unitCost: zMoneyNonNegative.optional(),
  notes: z.string().min(1, "notes (a reason) is required for an adjustment."),
  reference: z.string().min(1).optional(),
});

const zWriteOffBody = z.object({
  productId: z.string().min(1, "productId is required."),
  quantity: zQuantityPositive,
  notes: z.string().min(1, "notes (a reason) is required for a write-off."),
  reference: z.string().min(1).optional(),
});

const zSupplierCreate = z.object({
  name: z.string().trim().min(1, "name is required."),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  kraPin: z.string().optional(),
  paymentTerms: z.string().optional(),
  leadTimeDays: z.number().int("leadTimeDays must be an integer.").optional(),
});

const zSupplierUpdate = z.object({
  name: z.string().trim().min(1, "name must be a non-empty string.").optional(),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  kraPin: z.string().optional(),
  paymentTerms: z.string().optional(),
  leadTimeDays: z.number().int("leadTimeDays must be an integer or null.").nullable().optional(),
  isActive: z.boolean().optional(),
});

const zReconciliation = z.object({
  inventoryValue: zCentsString,
  glAccount1200Balance: zCentsString,
  difference: zCentsString,
  reconciled: z.boolean(),
  byLocationTotal: zCentsString.meta({
    description: "Sum of the per-location values; equals inventoryValue exactly.",
  }),
  locationSplitMatches: z.boolean(),
  zeroInvariantHolds: z.boolean().meta({
    description:
      "stockCount = 0 implies stockValue = 0 for every product. One-directional: zero-cost positive stock (donated goods) is legal.",
  }),
});

// ---- Per-location owned stock (Task 10.1) ----

const zLocationStockRow = z.object({
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  locationId: z.string(),
  locationCode: z.string(),
  locationName: z.string(),
  quantity: zDecimalString.meta({
    description:
      "Total OWNED at this location, frozen included. This is the figure that sums to Product.stockCount.",
  }),
  frozenQuantity: zDecimalString.meta({
    description:
      "The immobilised portion: an expired offline lease awaiting reconciliation (Task OFF.1). Usually 0. A freeze does not change `quantity` — frozen stock is still owned and still carried in stockValue and GL 1200, which is why it posts no journal entry.",
  }),
  sellableQuantity: zDecimalString.meta({
    description:
      "quantity - frozenQuantity: what this location may actually sell or send. Every outbound movement and every transfer source is checked against THIS.",
  }),
  avgCost: zCentsString,
  avgCostPrecise: zDecimalString,
  value: zCentsString.meta({
    description:
      "This slice's residual-allocated share of the product's authoritative stockValue, derived from the TOTAL owned quantity. Derived — there are no per-location cost layers.",
  }),
});

const zTransferBody = z.object({
  productId: z.string().min(1, "productId is required."),
  fromLocationId: z.string().min(1, "fromLocationId is required."),
  toLocationId: z.string().min(1, "toLocationId is required."),
  quantity: zQuantityPositive,
  reference: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
});

const zTransferResult = z.object({
  productId: z.string(),
  sku: z.string(),
  quantity: zDecimalString,
  fromLocationId: z.string(),
  fromLocationCode: z.string(),
  fromQuantityAfter: zDecimalString,
  toLocationId: z.string(),
  toLocationCode: z.string(),
  toQuantityAfter: zDecimalString,
  productStockCount: zDecimalString.meta({
    description:
      "The tenant-wide aggregate. A transfer NEVER changes it — echoed so the caller can see it did not move.",
  }),
  avgCost: zCentsString.meta({
    description: "The derived tenant-wide rate. Unchanged by a transfer: nothing was bought or sold.",
  }),
  avgCostPrecise: zDecimalString,
  valueMoved: zCentsString.meta({
    description:
      "The transferred quantity's proportional share of the carrying value. Recorded on the audit movements only — a transfer posts NO journal entry and does not move Product.stockValue.",
  }),
  outMovementId: z.string(),
  inMovementId: z.string(),
  createdAt: zTimestamp,
});

function orNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

// Insufficient stock and a closed period are STATE-dependent rules — they
// depend on rows in the database, not on the request's shape — so they cannot
// live in a schema. They stay in the inventory/ledger services and surface here.
function sendInventoryError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PeriodClosedError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (
    error instanceof InsufficientStockError ||
    error instanceof InventoryValidationError ||
    error instanceof LedgerValidationError
  ) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];
  const readRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "ACCOUNTANT",
    "WAREHOUSE_STAFF",
    "CASHIER",
    "VIEWER_AUDITOR",
  );
  const stockWriteRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF");
  const writeOffRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER");
  const valuationRoles = app.requireRole("MSME_OWNER", "ACCOUNTANT", "VIEWER_AUDITOR");
  const supplierRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER");
  const locationReadRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "WAREHOUSE_STAFF",
    "ACCOUNTANT",
    "VIEWER_AUDITOR",
  );

  api.route({
    method: "GET",
    url: "/locations",
    preHandler: [...base, locationReadRoles],
    schema: {
      tags: ["Inventory"],
      summary: "List stock locations",
      description:
        "Read-only convenience view for stock screens, serving the SAME rows and the SAME `Location` schema as `GET /v1/locations` — one service read behind both, so the two can never disagree. Creating a location and setting its lease/session policy lives under `/v1/locations`.",
      security: SECURE,
      response: {
        200: z.object({ data: z.array(zLocation), count: z.number().int() }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (request, reply) => {
      const data = await listLocations(request.tenantDb);
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/stock-by-location",
    preHandler: [...base, valuationRoles],
    schema: {
      tags: ["Inventory"],
      summary: "Stock value grouped by location",
      description:
        "What each location holds, valued as its residual-allocated share of each product's authoritative stockValue. Every location is listed, including ones holding nothing. Includes the reconciliation against GL account 1200.",
      security: SECURE,
      response: {
        200: z.object({
          locations: z.array(
            z.object({
              locationId: z.string(),
              code: z.string(),
              name: z.string(),
              stockValue: zCentsString,
            }),
          ),
          totalStockValue: zCentsString,
          reconciliation: z.object({
            byLocationTotal: zCentsString,
            productAggregate: zCentsString,
            glAccount1200Balance: zCentsString,
            difference: zCentsString,
            reconciled: z.boolean(),
          }),
        }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (request, reply) => {
      const result = await getStockByLocation(request.tenantDb);
      return reply.code(200).send(result);
    },
  });

  api.route({
    method: "GET",
    url: "/stock",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Inventory"],
      summary: "Current stock levels",
      security: SECURE,
      querystring: z.object({
        category: z.string().optional(),
        belowReorder: z.string().optional().meta({
          description: 'Pass "true" to return only products at or below their reorder threshold.',
        }),
      }),
      response: {
        200: z.object({ data: z.array(zStockLevelRow), count: z.number().int() }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (request, reply) => {
      const { category, belowReorder } = request.query;
      const rows = await getStockLevels(request.tenantDb, {
        ...(category !== undefined && category !== "" ? { category } : {}),
        belowReorderOnly: belowReorder === "true",
      });
      return reply.code(200).send({ data: rows, count: rows.length });
    },
  });

  // --- Per-location owned stock (Task 10.1) ---
  api.route({
    method: "GET",
    url: "/stock/by-location",
    preHandler: [...base, locationReadRoles],
    schema: {
      tags: ["Inventory"],
      summary: "Per-location owned stock",
      description:
        "What each location OWNS, product by product. Every location owns its stock exclusively — nothing sells stock it does not own — so these slices are what a till or storefront may actually sell. value is this slice's residual-allocated share of the product's authoritative stockValue; there are no per-location cost layers.",
      security: SECURE,
      querystring: z.object({
        locationId: z.string().min(1).optional(),
        productId: z.string().min(1).optional(),
      }),
      response: {
        200: z.object({ data: z.array(zLocationStockRow), count: z.number().int() }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { locationId, productId } = request.query;
      const data = await getLocationStock(request.tenantDb, {
        ...(locationId !== undefined ? { locationId } : {}),
        ...(productId !== undefined ? { productId } : {}),
      });
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/stock/:productId/by-location",
    preHandler: [...base, locationReadRoles],
    schema: {
      tags: ["Inventory"],
      summary: "One product's stock split across locations",
      description:
        "The per-location split plus the tenant-wide aggregate and a computed check that they agree. `matches` is the invariant Product.stockCount == SUM(per-location quantities); it must always be true.",
      security: SECURE,
      params: z.object({ productId: z.string().min(1) }),
      response: {
        200: z.object({
          productId: z.string(),
          sku: z.string(),
          name: z.string(),
          aggregateStockCount: zDecimalString,
          locationTotal: zDecimalString,
          matches: z.boolean(),
          stockValue: zCentsString,
          locationValueTotal: zCentsString,
          valueMatches: z.boolean(),
          avgCost: zCentsString,
          avgCostPrecise: zDecimalString,
          locations: z.array(
            z.object({
              locationId: z.string(),
              locationCode: z.string(),
              locationName: z.string(),
              quantity: zDecimalString,
              value: zCentsString,
            }),
          ),
        }),
        ...errorResponses(401, 403, 404),
      },
    },
    handler: async (request, reply) => {
      const { productId } = request.params;
      const result = await getProductLocationSplit(request.tenantDb, productId);
      if (result === null) {
        return reply.code(404).send(notFound(`No product with id "${productId}".`));
      }
      return reply.code(200).send(result);
    },
  });

  api.route({
    method: "POST",
    url: "/transfers",
    preHandler: [...base, stockWriteRoles],
    schema: {
      tags: ["Inventory"],
      summary: "Transfer owned stock between locations",
      description:
        "Moves owned quantity from one location to another as two immutable stock movements (TRANSFER_OUT and TRANSFER_IN).\n\n" +
        "**A transfer is value-neutral: it posts NO journal entry.** No value enters or leaves the business — the same goods are simply held somewhere else — so the tenant-wide stockCount, stockValue and avgCost are all unchanged and only the per-location split moves. Rejected with 400 if the source location does not own enough, naming the available quantity.",
      security: SECURE,
      body: zTransferBody,
      response: {
        201: zTransferResult,
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      try {
        const result = await transferStock(request.tenantDb, {
          productId: body.productId,
          fromLocationId: body.fromLocationId,
          toLocationId: body.toLocationId,
          quantity: body.quantity.trim(),
          ...(body.reference !== undefined ? { reference: body.reference } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          createdBy: auth.userId,
        });
        return reply.code(201).send(result);
      } catch (error) {
        return sendInventoryError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/stock/:productId/movements",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Inventory"],
      summary: "Stock movement history for a product",
      description:
        "The immutable audit trail: every movement with the balance and average cost after it.",
      security: SECURE,
      params: z.object({ productId: z.string().min(1) }),
      querystring: zPaginationWithDefault(25).extend({
        from: zIsoDate.optional(),
        to: zIsoDate.optional(),
      }),
      response: {
        200: z.object({
          productId: z.string(),
          rows: z.array(zMovementHistoryRow),
          pagination: zPaginationResult,
        }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { productId } = request.params;
      const { from, to, take, skip } = request.query;

      let fromDate: Date | undefined;
      if (from !== undefined) {
        const parsed = isoDateToUtc(from);
        if (parsed === null) {
          return reply.code(400).send(badRequest("from must be YYYY-MM-DD."));
        }
        fromDate = parsed;
      }
      let toDate: Date | undefined;
      if (to !== undefined) {
        const parsed = isoDateToUtc(to);
        if (parsed === null) {
          return reply.code(400).send(badRequest("to must be YYYY-MM-DD."));
        }
        toDate = parsed;
      }

      const result = await getMovementHistory(
        request.tenantDb,
        productId,
        fromDate,
        toDate,
        take,
        skip,
      );
      return reply.code(200).send(result);
    },
  });

  api.route({
    method: "POST",
    url: "/receipts",
    preHandler: [...base, stockWriteRoles],
    schema: {
      tags: ["Inventory"],
      summary: "Receive stock from a supplier",
      description:
        "Records a PURCHASE_RECEIPT, recomputes weighted-average cost, and posts the matching journal entry in one transaction. quantity and unitCost are decimal strings.",
      security: SECURE,
      body: zReceiptBody,
      response: {
        201: zStockMovementResult,
        ...errorResponses(400, 401, 403, 409),
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      const input: RecordStockMovementInput = {
        productId: body.productId,
        movementType: "PURCHASE_RECEIPT",
        quantity: body.quantity.trim(),
        unitCost: parseMoneyToCents(body.unitCost),
        createdBy: auth.userId,
        paidImmediately: body.paidImmediately === true,
        ...(body.supplierId !== undefined ? { supplierId: body.supplierId } : {}),
        ...(body.reference !== undefined ? { reference: body.reference } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      };

      try {
        const result = await recordStockMovement(request.tenantDb, input);
        return reply.code(201).send(result);
      } catch (error) {
        return sendInventoryError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/adjustments",
    preHandler: [...base, stockWriteRoles],
    schema: {
      tags: ["Inventory"],
      summary: "Adjust stock up or down",
      description:
        "notes (the reason) is mandatory — an unexplained adjustment is not auditable. unitCost is required for ADJUSTMENT_INCREASE and ignored for ADJUSTMENT_DECREASE, which is valued at the current average cost.",
      security: SECURE,
      body: zAdjustmentBody,
      response: {
        201: zStockMovementResult,
        ...errorResponses(400, 401, 403, 409),
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;

      // CROSS-FIELD RULE, kept in the handler: unitCost is required only when
      // movementType is ADJUSTMENT_INCREASE. Expressing this as a discriminated
      // union would change the documented body from one object into a oneOf,
      // altering the published contract for no behavioural gain.
      if (body.movementType === "ADJUSTMENT_INCREASE" && body.unitCost === undefined) {
        return reply
          .code(400)
          .send(badRequest("unitCost is required and must be a decimal string, not a number."));
      }

      const input: RecordStockMovementInput = {
        productId: body.productId,
        movementType: body.movementType,
        quantity: body.quantity.trim(),
        createdBy: auth.userId,
        notes: body.notes,
        ...(body.reference !== undefined ? { reference: body.reference } : {}),
        ...(body.movementType === "ADJUSTMENT_INCREASE" && body.unitCost !== undefined
          ? { unitCost: parseMoneyToCents(body.unitCost) }
          : {}),
      };

      try {
        const result = await recordStockMovement(request.tenantDb, input);
        return reply.code(201).send(result);
      } catch (error) {
        return sendInventoryError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/write-offs",
    preHandler: [...base, writeOffRoles],
    schema: {
      tags: ["Inventory"],
      summary: "Write stock off (damage, expiry, shrinkage)",
      description:
        "Valued at the product's current average cost and expensed through the ledger. notes (the reason) is mandatory.",
      security: SECURE,
      body: zWriteOffBody,
      response: {
        201: zStockMovementResult,
        ...errorResponses(400, 401, 403, 409),
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      const input: RecordStockMovementInput = {
        productId: body.productId,
        movementType: "WRITE_OFF",
        quantity: body.quantity.trim(),
        createdBy: auth.userId,
        notes: body.notes,
        ...(body.reference !== undefined ? { reference: body.reference } : {}),
      };

      try {
        const result = await recordStockMovement(request.tenantDb, input);
        return reply.code(201).send(result);
      } catch (error) {
        return sendInventoryError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/valuation",
    preHandler: [...base, valuationRoles],
    schema: {
      tags: ["Inventory"],
      summary: "Inventory valuation with GL reconciliation and location breakdown",
      description:
        "Total stock value per product plus the reconciliation invariant sum(Product.stockValue) = GL balance of account 1200; difference must be 0.\n\n" +
        "`byLocation` shows WHERE that stock physically sits. The GL reconciliation stays tenant-wide (account 1200 is not per-location); the per-location values are a derived, residual-allocated projection of the authoritative stockValue and sum EXACTLY to it (`locationSplitMatches`). There are no per-location cost layers.",
      security: SECURE,
      querystring: z.object({ asOf: zIsoDate.optional() }),
      response: {
        200: z.object({
          asOf: z.string(),
          totalStockValue: zCentsString,
          products: z.array(
            z.object({
              productId: z.string(),
              sku: z.string(),
              name: z.string(),
              stockCount: zDecimalString,
              avgCost: zCentsString,
              avgCostPrecise: zDecimalString,
              stockValue: zCentsString,
            }),
          ),
          byLocation: z.array(
            z.object({
              locationId: z.string(),
              locationCode: z.string(),
              locationName: z.string(),
              quantity: zDecimalString,
              value: zCentsString,
            }),
          ),
          reconciliation: zReconciliation,
        }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const raw = request.query.asOf;
      const asOf = raw === undefined ? businessTodayDate() : isoDateToUtc(raw);
      if (asOf === null) {
        return reply.code(400).send(badRequest("asOf must be YYYY-MM-DD."));
      }
      const result = await getInventoryValuation(request.tenantDb, asOf);
      return reply.code(200).send(result);
    },
  });

  api.route({
    method: "GET",
    url: "/suppliers",
    preHandler: [...base, supplierRoles],
    schema: {
      tags: ["Inventory"],
      summary: "List suppliers",
      security: SECURE,
      response: {
        200: z.object({ data: z.array(zSupplier) }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (request, reply) => {
      const suppliers = await request.tenantDb.supplier.findMany({ orderBy: { name: "asc" } });
      return reply.code(200).send({ data: suppliers });
    },
  });

  api.route({
    method: "POST",
    url: "/suppliers",
    preHandler: [...base, supplierRoles],
    schema: {
      tags: ["Inventory"],
      summary: "Create a supplier",
      security: SECURE,
      body: zSupplierCreate,
      response: { 201: zSupplier, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const body = request.body;
      const created = await request.tenantDb.supplier.create({
        data: {
          name: body.name,
          contactName: orNull(body.contactName),
          phone: orNull(body.phone),
          email: orNull(body.email),
          kraPin: orNull(body.kraPin),
          paymentTerms: orNull(body.paymentTerms),
          leadTimeDays: body.leadTimeDays ?? null,
        },
      });
      return reply.code(201).send(created);
    },
  });

  api.route({
    method: "PATCH",
    url: "/suppliers/:id",
    preHandler: [...base, supplierRoles],
    schema: {
      tags: ["Inventory"],
      summary: "Update a supplier",
      security: SECURE,
      params: zIdParam,
      body: zSupplierUpdate,
      response: { 200: zSupplier, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      const data: {
        name?: string;
        contactName?: string | null;
        phone?: string | null;
        email?: string | null;
        kraPin?: string | null;
        paymentTerms?: string | null;
        leadTimeDays?: number | null;
        isActive?: boolean;
      } = {};
      if (body.name !== undefined) {
        data.name = body.name;
      }
      if (body.contactName !== undefined) {
        data.contactName = orNull(body.contactName);
      }
      if (body.phone !== undefined) {
        data.phone = orNull(body.phone);
      }
      if (body.email !== undefined) {
        data.email = orNull(body.email);
      }
      if (body.kraPin !== undefined) {
        data.kraPin = orNull(body.kraPin);
      }
      if (body.paymentTerms !== undefined) {
        data.paymentTerms = orNull(body.paymentTerms);
      }
      if (body.leadTimeDays !== undefined) {
        data.leadTimeDays = body.leadTimeDays;
      }
      if (body.isActive !== undefined) {
        data.isActive = body.isActive;
      }

      const existing = await request.tenantDb.supplier.findUnique({ where: { id } });
      if (existing === null) {
        return reply.code(404).send(notFound(`No supplier with id "${id}".`));
      }
      const updated = await request.tenantDb.supplier.update({ where: { id }, data });
      return reply.code(200).send(updated);
    },
  });
}
