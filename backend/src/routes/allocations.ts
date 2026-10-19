// ===========================================================================
// Allocation workflow routes (Module 10, Task 10.2).
//
// These routes authorise and delegate. All allocation state goes through
// src/services/allocation.ts; all stock movement goes through
// src/services/inventory.ts's value-neutral transfer. No route here writes a
// stock table, and none posts a journal entry — an allocation moves goods
// between the tenant's own locations, so no value enters or leaves the business.
//
// Quantities are decimal STRINGS everywhere (a JSON number is rejected by the
// schema). There is no money on this surface: an allocation has no price.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  allocateStock,
  cancelAllocationRequest,
  createAllocationRequest,
  decideAllocationRequest,
  getAllocationRequest,
  getLowStockAlerts,
  getPendingAllocationRequests,
  listAllocationRequests,
  AllocationForbiddenError,
  AllocationStateError,
  AllocationValidationError,
} from "../services/allocation";
import { InsufficientStockError, InventoryValidationError } from "../services/inventory";
import { LocationStateError, LocationValidationError } from "../services/locations";
import {
  zAllocationRequest,
  zAllocationRequestStatus,
  zLowStockAlert,
} from "../schemas/models";
import {
  badRequest,
  conflict,
  errorBody,
  errorResponses,
  forbidden,
  notFound,
  SECURE,
  zDecimalString,
  zIdParam,
  zQuantityPositive,
  zTimestamp,
} from "../schemas/common";

const zAllocateBody = z.object({
  productId: z.string().min(1, "productId is required."),
  fromLocationId: z.string().min(1).optional().meta({
    description:
      "Defaults to the tenant's MAIN pool. Name another location to move stock between two selling locations.",
  }),
  toLocationId: z.string().min(1, "toLocationId is required."),
  quantity: zQuantityPositive,
  note: z.string().min(1).optional(),
});

const zAllocateResult = z.object({
  productId: z.string(),
  sku: z.string(),
  quantity: zDecimalString,
  fromLocationId: z.string(),
  fromLocationCode: z.string(),
  fromQuantityAfter: zDecimalString,
  toLocationId: z.string(),
  toLocationCode: z.string(),
  toQuantityAfter: zDecimalString,
  sourceDefaulted: z.boolean().meta({
    description: "true when no fromLocationId was given and the MAIN pool was used.",
  }),
  productStockCount: zDecimalString.meta({
    description:
      "The tenant-wide aggregate. An allocation NEVER changes it — only the per-location split moves.",
  }),
  outMovementId: z.string(),
  inMovementId: z.string(),
  createdAt: zTimestamp,
});

const zRequestBody = z.object({
  productId: z.string().min(1, "productId is required."),
  locationId: z.string().min(1, "locationId is required."),
  requestedQty: zQuantityPositive,
  note: z.string().min(1).optional(),
});

const zDecideBody = z.object({
  decision: z.enum(["APPROVED", "DECLINED"]),
  approvedQty: zQuantityPositive.optional().meta({
    description:
      "Approvals only. Omit to grant the full requested quantity; supply a different figure to edit the grant down (or up).",
  }),
});

// State-dependent rules — is this request still pending, does MAIN own enough,
// is the destination active — depend on rows in the database, not on the shape
// of the request, so they stay in the services and surface here.
function sendAllocationError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AllocationForbiddenError) {
    return reply.code(403).send(forbidden(error.message));
  }
  if (error instanceof AllocationStateError || error instanceof LocationStateError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (
    error instanceof AllocationValidationError ||
    error instanceof InsufficientStockError ||
    error instanceof InventoryValidationError ||
    error instanceof LocationValidationError
  ) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

export async function allocationRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];

  // Pushing stock into a location is a stock operation — the same roles that
  // may transfer stock.
  const allocateRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF");
  // Asking for more stock is what an attendant at a till does.
  const requestRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "WAREHOUSE_STAFF",
    "CASHIER",
  );
  // Deciding is an administrative act; it is what actually moves the stock.
  const decideRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER");
  const readRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "WAREHOUSE_STAFF",
    "CASHIER",
    "ACCOUNTANT",
    "VIEWER_AUDITOR",
  );

  api.route({
    method: "POST",
    url: "/",
    preHandler: [...base, allocateRoles],
    schema: {
      tags: ["Allocations"],
      summary: "Allocate stock to a location (direct, no prior request)",
      description:
        "An admin pushing stock into a selling location. This IS a transfer — the value-neutral TRANSFER_OUT/TRANSFER_IN pair from Task 10.1 — wrapped in allocation semantics:\n\n" +
        "* **No journal entry.** Nothing was bought or sold; the goods are simply held somewhere else.\n" +
        "* **Product.stockCount, stockValue and avgCost are unchanged.** Only the per-location split moves, so `sum(stockValue) = GL(1200)` keeps holding.\n" +
        "* **Two immutable stock movements** are written, so the allocation is fully auditable.\n\n" +
        "Rejected with 400 if the source location does not own enough, naming the available quantity — nothing sells or sends stock it does not own.",
      security: SECURE,
      body: zAllocateBody,
      response: { 201: zAllocateResult, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      try {
        const result = await allocateStock(request.tenantDb, {
          productId: body.productId,
          ...(body.fromLocationId !== undefined
            ? { fromLocationId: body.fromLocationId }
            : {}),
          toLocationId: body.toLocationId,
          quantity: body.quantity.trim(),
          createdBy: auth.userId,
          ...(body.note !== undefined ? { note: body.note } : {}),
        });
        const { transfer } = result;
        return reply.code(201).send({
          productId: transfer.productId,
          sku: transfer.sku,
          quantity: transfer.quantity,
          fromLocationId: transfer.fromLocationId,
          fromLocationCode: transfer.fromLocationCode,
          fromQuantityAfter: transfer.fromQuantityAfter,
          toLocationId: transfer.toLocationId,
          toLocationCode: transfer.toLocationCode,
          toQuantityAfter: transfer.toQuantityAfter,
          sourceDefaulted: result.sourceDefaulted,
          productStockCount: transfer.productStockCount,
          outMovementId: transfer.outMovementId,
          inMovementId: transfer.inMovementId,
          createdAt: transfer.createdAt,
        });
      } catch (error) {
        return sendAllocationError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/requests",
    preHandler: [...base, requestRoles],
    schema: {
      tags: ["Allocations"],
      summary: "Request more stock into a location",
      description:
        "An attendant asking for a top-up. **This moves NO stock.** Nothing is transferred, nothing is reserved, no stock movement is written and no journal entry is posted — the request is a proposal that lands in the admin's queue as PENDING. Stock moves only when an admin approves it.\n\n" +
        "The MAIN pool cannot be the requesting location: a request asks for stock to be moved INTO a selling location, out of the pool.",
      security: SECURE,
      body: zRequestBody,
      response: { 201: zAllocationRequest, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      try {
        const created = await createAllocationRequest(request.tenantDb, {
          productId: body.productId,
          locationId: body.locationId,
          requestedQty: body.requestedQty.trim(),
          requestedBy: auth.userId,
          ...(body.note !== undefined ? { note: body.note } : {}),
        });
        return reply.code(201).send(created);
      } catch (error) {
        return sendAllocationError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/requests",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Allocations"],
      summary: "List allocation requests",
      description:
        "Newest first. Filter by status (`PENDING` is the admin's queue), by location, or by product.",
      security: SECURE,
      querystring: z.object({
        status: zAllocationRequestStatus.optional(),
        locationId: z.string().min(1).optional(),
        productId: z.string().min(1).optional(),
      }),
      response: {
        200: z.object({ data: z.array(zAllocationRequest), count: z.number().int() }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { status, locationId, productId } = request.query;
      const data = await listAllocationRequests(request.tenantDb, {
        ...(status !== undefined ? { status } : {}),
        ...(locationId !== undefined ? { locationId } : {}),
        ...(productId !== undefined ? { productId } : {}),
      });
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/requests/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Allocations"],
      summary: "Get one allocation request",
      security: SECURE,
      params: zIdParam,
      response: { 200: zAllocationRequest, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const found = await getAllocationRequest(request.tenantDb, id);
      if (found === null) {
        return reply.code(404).send(notFound(`No allocation request with id "${id}".`));
      }
      return reply.code(200).send(found);
    },
  });

  api.route({
    method: "POST",
    url: "/requests/:id/decide",
    preHandler: [...base, decideRoles],
    schema: {
      tags: ["Allocations"],
      summary: "Approve or decline a pending allocation request",
      description:
        "**APPROVED** transfers the granted quantity from MAIN into the requesting location and links the resulting TRANSFER_IN movement as `transferId`. The status flip and the transfer happen in ONE transaction: a request can never read APPROVED without its stock having moved, and stock can never move against a request still in the queue. The transfer is value-neutral — no journal entry, aggregate and carrying value untouched.\n\n" +
        "**DECLINED** records the decision and moves nothing.\n\n" +
        "Omit `approvedQty` to grant the full request; supply it to edit the grant.\n\n" +
        "**409** if the request is not PENDING — a decided request is final, and a second decide is refused (the database enforces this too, so two concurrent approvals cannot both transfer).\n\n" +
        "**400** if MAIN does not own enough for the approved quantity: the transaction rolls back, nothing moves, and the request STAYS PENDING so it can be approved for less or after a restock. A failed approval is not a decision.",
      security: SECURE,
      params: zIdParam,
      body: zDecideBody,
      response: { 200: zAllocationRequest, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const { id } = request.params;
      const body = request.body;

      // CROSS-FIELD RULE, kept in the handler: approvedQty belongs only to an
      // approval. Silently ignoring it on a decline would let a caller believe
      // they had granted something.
      if (body.decision === "DECLINED" && body.approvedQty !== undefined) {
        return reply
          .code(400)
          .send(badRequest("approvedQty applies only to an approval; a declined request grants nothing."));
      }

      try {
        const decided = await decideAllocationRequest(request.tenantDb, id, {
          decision: body.decision,
          ...(body.approvedQty !== undefined ? { approvedQty: body.approvedQty.trim() } : {}),
          decidedBy: auth.userId,
        });
        return reply.code(200).send(decided);
      } catch (error) {
        if (error instanceof AllocationValidationError && /^Unknown allocation request/.test(error.message)) {
          return reply.code(404).send(notFound(error.message));
        }
        return sendAllocationError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/requests/:id/cancel",
    preHandler: [...base, requestRoles],
    schema: {
      tags: ["Allocations"],
      summary: "Cancel your own pending allocation request",
      description:
        "The requester withdraws a request before it is decided. Moves no stock. **403** if the caller did not create the request — an admin declines it instead of cancelling it, so the queue records which of the two happened. **409** if it is no longer PENDING.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zAllocationRequest, ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const { id } = request.params;
      try {
        const cancelled = await cancelAllocationRequest(request.tenantDb, id, auth.userId);
        return reply.code(200).send(cancelled);
      } catch (error) {
        if (error instanceof AllocationValidationError && /^Unknown allocation request/.test(error.message)) {
          return reply.code(404).send(notFound(error.message));
        }
        return sendAllocationError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/low-stock",
    preHandler: [...base, decideRoles],
    schema: {
      tags: ["Allocations"],
      summary: "The allocation admin's alert feed",
      description:
        "Everything needing the admin's attention: per-location slices at or below their reorder threshold, plus the pending-request queue.\n\n" +
        "**This is DATA, not delivery.** Push, email and SMS notification is a later notifications module; this endpoint is what that module — and the dashboard — will read.\n\n" +
        "The threshold is `Product.minStockThreshold`, the catalog's existing reorder point, applied PER LOCATION SLICE. A threshold of **zero raises no alert**: without that rule every product would alarm at every location it has never stocked, and a feed that is always full is a feed nobody reads. A location reaching zero is separately a hard stop at the point of sale — that is the selling guard, not an alert.",
      security: SECURE,
      response: {
        200: z.object({
          lowStock: z.array(zLowStockAlert),
          lowStockCount: z.number().int(),
          pendingRequests: z.array(zAllocationRequest),
          pendingRequestCount: z.number().int(),
        }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (request, reply) => {
      const [lowStock, pendingRequests] = await Promise.all([
        getLowStockAlerts(request.tenantDb),
        getPendingAllocationRequests(request.tenantDb),
      ]);
      return reply.code(200).send({
        lowStock,
        lowStockCount: lowStock.length,
        pendingRequests,
        pendingRequestCount: pendingRequests.length,
      });
    },
  });
}
