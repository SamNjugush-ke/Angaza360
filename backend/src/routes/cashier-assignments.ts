// ===========================================================================
// Cashier location assignment routes (M4.5 Wave 3). Registered under /v1/pos.
//
// The owner or manager puts each cashier on a till; the cashier reads where they are and what is
// running low there. Every rule is in src/services/pos-assignment.ts; nothing here writes a
// table. The tenant is the session's — no route takes one.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getLowStockAlerts, listAllocationRequests } from "../services/allocation";
import {
  assignCashier,
  assignmentOf,
  isRestricted,
  listCashierAssignments,
  PosAssignmentNotFoundError,
  PosAssignmentValidationError,
  removeCashierAssignment,
} from "../services/pos-assignment";
import { zAllocationRequest, zLowStockAlert } from "../schemas/models";
import { badRequest, errorBody, errorResponses, notFound, SECURE, zTimestampNullable } from "../schemas/common";

const zAssignedLocation = z.object({ id: z.string(), code: z.string(), name: z.string(), type: z.string() });

const zCashierAssignment = z
  .object({
    userId: z.string(),
    fullName: z.string(),
    email: z.string(),
    location: zAssignedLocation.nullable().meta({ description: "Null: not assigned yet — the cashier cannot open a shift." }),
    assignedBy: z.string().nullable(),
    assignedAt: zTimestampNullable,
  })
  .meta({ id: "CashierAssignment" });

function sendAssignmentError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PosAssignmentNotFoundError) return reply.code(404).send(notFound(error.message));
  if (error instanceof PosAssignmentValidationError) return reply.code(400).send(badRequest(error.message));
  throw error;
}

export async function cashierAssignmentRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];
  const manageRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER");
  const tillRoles = app.requireRole("CASHIER", "MSME_MANAGER", "MSME_OWNER");
  const zUserParam = z.object({ userId: z.string().min(1) });

  api.route({
    method: "GET",
    url: "/cashier-assignments",
    preHandler: [...base, manageRoles],
    schema: {
      tags: ["POS"],
      summary: "Every active cashier of this business and the location they sell from",
      security: SECURE,
      response: { 200: z.object({ data: z.array(zCashierAssignment) }), ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const tenantId = request.auth?.tenantId ?? "";
      return reply.code(200).send({ data: await listCashierAssignments(request.tenantDb, tenantId) });
    },
  });

  api.route({
    method: "PUT",
    url: "/cashier-assignments/:userId",
    preHandler: [...base, manageRoles],
    schema: {
      tags: ["POS"],
      summary: "Assign (or reassign) a cashier to a selling location",
      description:
        "Takes effect at once. A cashier sells only from this location: their quote, sale and stock request name it or nothing, and their shift opens here. A shift they opened at their OLD location can no longer ring a sale — they close it and open one here. Any active location except a storefront. Another business's user, a non-cashier or an inactive account is 404.",
      security: SECURE,
      params: zUserParam,
      body: z.object({ locationId: z.string().min(1, "locationId is required.") }),
      response: { 200: zCashierAssignment, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      try {
        const view = await assignCashier(request.tenantDb, auth.tenantId ?? "", {
          userId: request.params.userId,
          locationId: request.body.locationId,
          assignedBy: auth.userId,
        });
        return reply.code(200).send(view);
      } catch (error) {
        return sendAssignmentError(reply, error);
      }
    },
  });

  api.route({
    method: "DELETE",
    url: "/cashier-assignments/:userId",
    preHandler: [...base, manageRoles],
    schema: {
      tags: ["POS"],
      summary: "Remove a cashier's location assignment",
      description: "They can open no new shift until assigned again. A shift already open stays open but can ring no further sale.",
      security: SECURE,
      params: zUserParam,
      response: { 204: z.void(), ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      try {
        await removeCashierAssignment(request.tenantDb, request.auth?.tenantId ?? "", request.params.userId);
        return reply.code(204).send();
      } catch (error) {
        return sendAssignmentError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/my-location",
    preHandler: [...base, tillRoles],
    schema: {
      tags: ["POS"],
      summary: "The till I sell from, what is running low there, and my stock requests",
      description:
        "A CASHIER: their assigned location (null if not assigned), its low-stock slices (the same threshold rule as the admin feed — a zero threshold raises nothing) and their own allocation requests, newest first. An owner or manager is not restricted (`restricted: false`, location null); they read the admin feed at GET /v1/allocations/low-stock.",
      security: SECURE,
      response: {
        200: z.object({
          restricted: z.boolean(),
          location: zAssignedLocation.nullable(),
          lowStock: z.array(zLowStockAlert),
          myRequests: z.array(zAllocationRequest),
        }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      if (!isRestricted(auth)) return reply.code(200).send({ restricted: false, location: null, lowStock: [], myRequests: [] });
      const location = await assignmentOf(request.tenantDb, auth.userId);
      if (location === null) return reply.code(200).send({ restricted: true, location: null, lowStock: [], myRequests: [] });
      const [lowStock, requests] = await Promise.all([
        getLowStockAlerts(request.tenantDb, location.id),
        listAllocationRequests(request.tenantDb, { locationId: location.id }),
      ]);
      return reply.code(200).send({
        restricted: true,
        location,
        lowStock,
        myRequests: requests.filter((r) => r.requestedBy === auth.userId),
      });
    },
  });
}
