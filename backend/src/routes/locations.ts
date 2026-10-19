// ===========================================================================
// Location management & per-location lease policy (Module 10, Task 10.2).
//
// These routes authorise and delegate; every write goes through
// src/services/locations.ts, which is the sole writer of the locations table and
// touches no stock table. Quantities in the deactivation error are decimal
// strings; there is no money on this surface at all.
//
// THE LEASE POLICY HERE IS CONFIGURATION. Setting leaseWindowMinutes stores a
// policy; it does not start, expire or freeze anything. Lease enforcement is the
// offline server foundation (the next task) — see the seam note at the top of
// src/services/locations.ts.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  activateLocation,
  createLocation,
  deactivateLocation,
  getLocation,
  listLocations,
  updateLocation,
  LocationStateError,
  LocationValidationError,
  DEFAULT_LEASE_WINDOW_MINUTES,
} from "../services/locations";
import { zLocation, zLocationType } from "../schemas/models";
import {
  badRequest,
  conflict,
  errorResponses,
  notFound,
  SECURE,
  zIdParam,
} from "../schemas/common";

const zLeaseWindow = z
  .number()
  .int("leaseWindowMinutes must be a whole number of minutes.")
  .positive("leaseWindowMinutes must be positive; use null for a lease that never expires.")
  .nullable()
  .meta({
    description:
      `Lease window in minutes. **null means FOREVER** — this location's allocation never freezes. Omit it on create and an offline-capable location gets the ${DEFAULT_LEASE_WINDOW_MINUTES.toString()}-minute (8 hour) default; omit it on update and the current value is kept. Only settable on an offline-capable location. Stored as policy — expiry and freezing are enforced by the offline server task, not here.`,
  });

const zSessionTime = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'must be a 24-hour "HH:MM" time.')
  .nullable()
  .meta({
    type: "string",
    nullable: true,
    examples: ["08:00"],
    description:
      'Daily session boundary as 24-hour "HH:MM". A wall-clock time of day, not an instant. sessionStart and sessionEnd must be set together or both left null.',
  });

const zCreateLocationBody = z.object({
  name: z.string().trim().min(1, "name is required."),
  code: z
    .string()
    .trim()
    .min(1, "code is required.")
    .meta({
      examples: ["TILL-1"],
      description:
        "Short stable code, stored uppercase. Appears in stock movement audit rows. 1-24 characters of A-Z, 0-9, underscore or hyphen.",
    }),
  type: zLocationType.meta({
    description:
      "MAIN cannot be created — every tenant has exactly one, seeded at provisioning. Use POS for a till, ECOMMERCE for a storefront channel; BRANCH and ATTENDANT are the same model and need no schema change.",
  }),
  isOfflineCapable: z.boolean().optional().meta({
    description:
      "Defaults to false. Must be false for MAIN and ECOMMERCE: the pool is server-held and a storefront is server-side.",
  }),
  leaseWindowMinutes: zLeaseWindow.optional(),
  sessionStart: zSessionTime.optional(),
  sessionEnd: zSessionTime.optional(),
});

const zUpdateLocationBody = z.object({
  name: z.string().trim().min(1, "name must be a non-empty string.").optional(),
  type: zLocationType.optional().meta({
    description: "Cannot be changed to or from MAIN.",
  }),
  isOfflineCapable: z.boolean().optional().meta({
    description:
      "Turning this off also clears leaseWindowMinutes, because a lease has no meaning on an always-online location.",
  }),
  leaseWindowMinutes: zLeaseWindow.optional(),
  sessionStart: zSessionTime.optional(),
  sessionEnd: zSessionTime.optional(),
});

// Coherence rules (MAIN is never offline-capable, a lease needs an offline
// location, a session window is both ends or neither) depend on the STORED row
// as well as the request, so they live in the service and surface here — a
// schema validates the shape of one request, not the state it lands on.
function sendLocationError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof LocationStateError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof LocationValidationError) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

export async function locationRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];

  // Broad read: a cashier needs to know which location their till is, and an
  // auditor needs to see where stock can sit.
  const readRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "ACCOUNTANT",
    "WAREHOUSE_STAFF",
    "CASHIER",
    "VIEWER_AUDITOR",
  );
  // Creating a location and setting its lease policy is an administrative act.
  const manageRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER");

  api.route({
    method: "POST",
    url: "/",
    preHandler: [...base, manageRoles],
    schema: {
      tags: ["Locations"],
      summary: "Create a selling location",
      description:
        "Creates a POS till, an e-commerce channel, a branch or an attendant location. MAIN cannot be created: every tenant has exactly one, seeded at provisioning, and it is the authoritative pool every allocation draws from.\n\n" +
        "**Lease policy is configuration.** `leaseWindowMinutes` is stored and returned; nothing in this task expires a lease or freezes stock. Enforcement is the offline server foundation.",
      security: SECURE,
      body: zCreateLocationBody,
      response: { 201: zLocation, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const body = request.body;
      try {
        const created = await createLocation(request.tenantDb, {
          name: body.name,
          code: body.code,
          type: body.type,
          ...(body.isOfflineCapable !== undefined
            ? { isOfflineCapable: body.isOfflineCapable }
            : {}),
          ...(body.leaseWindowMinutes !== undefined
            ? { leaseWindowMinutes: body.leaseWindowMinutes }
            : {}),
          ...(body.sessionStart !== undefined ? { sessionStart: body.sessionStart } : {}),
          ...(body.sessionEnd !== undefined ? { sessionEnd: body.sessionEnd } : {}),
        });
        return reply.code(201).send(created);
      } catch (error) {
        return sendLocationError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Locations"],
      summary: "List locations",
      description:
        "Every location and its lease/session policy. Ordered by code. Filter by type or to active locations only.",
      security: SECURE,
      querystring: z.object({
        type: zLocationType.optional(),
        activeOnly: z.string().optional().meta({
          description: 'Pass "true" to exclude deactivated locations.',
        }),
      }),
      response: {
        200: z.object({ data: z.array(zLocation), count: z.number().int() }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { type, activeOnly } = request.query;
      const data = await listLocations(request.tenantDb, {
        ...(type !== undefined ? { type } : {}),
        activeOnly: activeOnly === "true",
      });
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Locations"],
      summary: "Get one location",
      security: SECURE,
      params: zIdParam,
      response: { 200: zLocation, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const location = await getLocation(request.tenantDb, id);
      if (location === null) {
        return reply.code(404).send(notFound(`No location with id "${id}".`));
      }
      return reply.code(200).send(location);
    },
  });

  api.route({
    method: "PATCH",
    url: "/:id",
    preHandler: [...base, manageRoles],
    schema: {
      tags: ["Locations"],
      summary: "Update a location's name and lease/session policy",
      description:
        "Changing `leaseWindowMinutes` is explicitly allowed — the admin must be able to set the policy before anything reads it. Send `null` for a lease that never expires; omit the field to leave it unchanged.\n\n" +
        "`isActive` is deliberately NOT settable here: deactivation has a guard (it refuses while the location still owns stock) and must not be reachable by a plain field write. Use `/deactivate` and `/activate`.",
      security: SECURE,
      params: zIdParam,
      body: zUpdateLocationBody,
      response: { 200: zLocation, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      try {
        // Absent keys are DROPPED rather than passed as explicit undefined: the
        // service distinguishes "not supplied" (leave unchanged) from "supplied
        // as null" (forever / no session window), and that distinction is the
        // whole meaning of a null lease window.
        const updated = await updateLocation(request.tenantDb, id, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.isOfflineCapable !== undefined
            ? { isOfflineCapable: body.isOfflineCapable }
            : {}),
          ...(body.leaseWindowMinutes !== undefined
            ? { leaseWindowMinutes: body.leaseWindowMinutes }
            : {}),
          ...(body.sessionStart !== undefined ? { sessionStart: body.sessionStart } : {}),
          ...(body.sessionEnd !== undefined ? { sessionEnd: body.sessionEnd } : {}),
        });
        if (updated === null) {
          return reply.code(404).send(notFound(`No location with id "${id}".`));
        }
        return reply.code(200).send(updated);
      } catch (error) {
        return sendLocationError(reply, error);
      }
    },
  });

  api.route({
    method: "PATCH",
    url: "/:id/deactivate",
    preHandler: [...base, manageRoles],
    schema: {
      tags: ["Locations"],
      summary: "Deactivate a location",
      description:
        "REFUSED with 409 while the location still owns stock, naming what it holds. A deactivated location cannot be a transfer source, so stock left on one would be stranded — owned by a location that can no longer send it anywhere, yet still counted in Product.stockCount and carried in GL account 1200. Transfer the stock out first.\n\n" +
        "The MAIN pool can never be deactivated. Deactivating an already-inactive location is a no-op.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zLocation, ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      try {
        const updated = await deactivateLocation(request.tenantDb, id);
        if (updated === null) {
          return reply.code(404).send(notFound(`No location with id "${id}".`));
        }
        return reply.code(200).send(updated);
      } catch (error) {
        return sendLocationError(reply, error);
      }
    },
  });

  api.route({
    method: "PATCH",
    url: "/:id/activate",
    preHandler: [...base, manageRoles],
    schema: {
      tags: ["Locations"],
      summary: "Reactivate a deactivated location",
      description:
        "The symmetric counterpart to /deactivate. Needs no guard: an inactive location owns no stock (that is what deactivation required). Reactivating an already-active location is a no-op.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zLocation, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const updated = await activateLocation(request.tenantDb, id);
      if (updated === null) {
        return reply.code(404).send(notFound(`No location with id "${id}".`));
      }
      return reply.code(200).send(updated);
    },
  });
}
