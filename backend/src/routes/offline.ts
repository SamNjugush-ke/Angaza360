// ===========================================================================
// OFFLINE SERVER ROUTES (Task OFF.1) — devices, custody, sync ingest, frozen
// allocation, the admin write-off, and the owner's resolution queue.
//
// These routes authorise and delegate. Every write goes through the offline
// services (custody / sync / freeze), which in turn route every stock effect
// through src/services/inventory.ts and every ledger effect through
// src/services/ledger.ts. No route here writes a sale, stock or journal table.
//
// THE SELLING LOCATION IS NEVER ACCEPTED FROM A REQUEST. A sync batch names its
// DEVICE; the server derives the location from the device's registration. A
// device may only ever sell from the location it was registered against, so
// letting a capture name its own location would hand a client the ability to draw
// stock out of any location it liked — the same reason the tenant comes from the
// session and not the body.
//
// Money and quantities are strings everywhere, as in every other route. There is
// no secret field on this surface.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  DeviceStateError,
  DeviceValidationError,
  endLease,
  getDevice,
  listDevices,
  registerDevice,
  renewLease,
  startLease,
} from "../services/offline/custody";
import {
  FreezeStateError,
  FreezeValidationError,
  getActiveFreezeForLocation,
  listActiveFreezeDetails,
  writeOffFrozenStock,
} from "../services/offline/freeze";
import {
  getSyncStatus,
  ingestSyncBatch,
  listNeedsResolution,
  SyncValidationError,
  type CapturedSaleInput,
} from "../services/offline/sync";
import { InsufficientStockError, InventoryValidationError } from "../services/inventory";
import { LedgerValidationError, PeriodClosedError } from "../services/ledger";
import { SaleValidationError } from "../services/sales";
import { LocationValidationError } from "../services/locations";
import {
  zDeviceStatus,
  zDeviceSyncStatus,
  zNeedsResolutionRow,
  zPosDevice,
  zStockFreezeDetail,
  zSyncBatchResult,
  zTenderType,
  zWriteOffResult,
} from "../schemas/models";
import {
  badRequest,
  conflict,
  errorBody,
  errorResponses,
  isoDateTimeToUtc,
  notFound,
  SECURE,
  zIsoDateTime,
  zMoneyNonNegative,
  zQuantity,
} from "../schemas/common";

const zRegisterDeviceBody = z.object({
  deviceName: z.string().trim().min(1, "deviceName is required.").meta({
    examples: ["Till 1 tablet"],
  }),
  locationId: z.string().min(1, "locationId is required.").meta({
    description:
      "The OFFLINE-CAPABLE location this device serves. Its owned stock IS the device's allocation. Refused for MAIN and ECOMMERCE, which can never be offline-capable, and for any location whose isOfflineCapable is false.",
  }),
});

// Same line/tender shape as an online sale, because a captured sale IS one — it is
// replayed through the same function. Deliberately NO sellingLocationId: the
// server derives it from the device.
const zCapturedLine = z.object({
  productId: z.string().min(1, "productId is required."),
  quantity: zQuantity,
  discount: zMoneyNonNegative.optional(),
});

const zCapturedTender = z.object({
  tenderType: zTenderType,
  amount: zMoneyNonNegative,
  mpesaReference: z.string().min(1).optional(),
});

const zCapturedSale = z.object({
  idempotencyKey: z.string().trim().min(1, "idempotencyKey is required.").max(200).meta({
    description:
      "The device's own unique key for this sale. Replaying it is a no-op — no second journal entry, no second stock decrement — which is what makes at-least-once delivery safe. Enforced by a unique index, not by convention.",
  }),
  businessTimestamp: zIsoDateTime.meta({
    description:
      "When the sale ACTUALLY happened at the till. The journal entry is DATED to this, so a sale made two days ago posts two days ago, into that accounting period. A timestamp in the future is queued rather than accepted.",
  }),
  shiftId: z.string().min(1, "shiftId is required.").meta({
    description:
      "The shift the sale was rung on. It must still be OPEN: a closed shift carries a counted, signed-off cash variance, and a late cash sale would falsify it. A capture whose shift has closed goes to the resolution queue — never dropped, never posted into a settled reconciliation.",
  }),
  customerId: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
  requestEtims: z.boolean().optional().meta({
    description:
      "The per-sale KRA eTIMS opt-in, captured OFFLINE (Task 4.1). A device cannot sign — eTIMS needs KRA — so it records only that the customer asked, and the SERVER signs on sync, after the sale posts through the atomic transaction. This is the deferred online operation the offline design anticipated: there is no second signing path. If KRA is unreachable when the batch arrives, the invoice QUEUES with its allocated number, which is simply the ordinary connectivity case.",
  }),
  lines: z.array(zCapturedLine).min(1, "lines must be a non-empty array."),
  tenders: z.array(zCapturedTender).min(1, "tenders must be a non-empty array."),
});

const zSyncBody = z.object({
  deviceId: z.string().min(1, "deviceId is required."),
  sales: z.array(zCapturedSale).meta({
    description:
      "The device's outbox. Processed OLDEST businessTimestamp FIRST, so periods fill in the order things actually happened. An empty array is a valid check-in: it records that the device has synced.",
  }),
});

const zWriteOffBody = z.object({
  reason: z.string().trim().min(1, "reason is required.").meta({
    examples: ["Tablet stolen from Till 1 on 2026-09-28; police report filed."],
    description:
      "Why the stock is being written off. A write-off is a recorded business decision and always names both its reason and its decider.",
  }),
});

// State-dependent rules — is this device active, does the location own the stock,
// is the period open, is the freeze still live — depend on rows in the database
// rather than on the shape of the request, so they stay in the services and
// surface here.
function sendOfflineError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DeviceStateError || error instanceof FreezeStateError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof PeriodClosedError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (
    error instanceof DeviceValidationError ||
    error instanceof FreezeValidationError ||
    error instanceof SyncValidationError ||
    error instanceof SaleValidationError ||
    error instanceof InsufficientStockError ||
    error instanceof InventoryValidationError ||
    error instanceof LedgerValidationError ||
    error instanceof LocationValidationError
  ) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

export async function offlineRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];

  // Registering a device is an administrative act: it decides which till may go
  // dark holding the shop's stock.
  const adminRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER");
  // Taking custody is what an attendant does at the start of a shift.
  const custodyRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "CASHIER");
  // Delivering a captured batch is the device operator's session.
  const syncRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "CASHIER");
  const readRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "CASHIER",
    "WAREHOUSE_STAFF",
    "ACCOUNTANT",
    "VIEWER_AUDITOR",
  );

  // --- Devices -------------------------------------------------------------

  api.route({
    method: "POST",
    url: "/devices",
    preHandler: [...base, adminRoles],
    schema: {
      tags: ["Offline"],
      summary: "Register an offline POS device",
      description:
        "Binds a device to ONE offline-capable location. That location's owned stock IS the device's allocation, and the device sells nothing else — which is what makes offline conflict-free: no other channel can touch the slice it sells from.\n\n" +
        "**400** if the location is not offline-capable. MAIN and ECOMMERCE can never be: the pool is server-held and a storefront is server-side, and attaching a lease clock (and therefore a possible freeze) to the tenant's authoritative pool would put the pool itself at risk. A database trigger enforces this too.\n\n" +
        "Registering moves no stock, reserves nothing and posts nothing.",
      security: SECURE,
      body: zRegisterDeviceBody,
      response: { 201: zPosDevice, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const device = await registerDevice(request.tenantDb, {
          deviceName: request.body.deviceName,
          locationId: request.body.locationId,
          registeredBy: auth.userId,
        });
        return reply.code(201).send(device);
      } catch (error) {
        return sendOfflineError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/devices",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Offline"],
      summary: "List devices with their lease status",
      description:
        "Every registered device, its location, and its custody state. `leaseExpiresAt` NULL means FOREVER — a lease that never expires (a permanent branch warehouse). `holdsCustody` is what the period-close guard looks at.",
      security: SECURE,
      querystring: z.object({
        locationId: z.string().min(1).optional(),
        status: zDeviceStatus.optional(),
      }),
      response: {
        200: z.object({ data: z.array(zPosDevice), count: z.number().int() }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { locationId, status } = request.query;
      const data = await listDevices(request.tenantDb, {
        ...(locationId !== undefined ? { locationId } : {}),
        ...(status !== undefined ? { status } : {}),
      });
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/devices/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Offline"],
      summary: "Get one device",
      security: SECURE,
      params: z.object({ id: z.string().min(1) }),
      response: { 200: zPosDevice, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const device = await getDevice(request.tenantDb, request.params.id);
      if (device === null) {
        return reply.code(404).send(notFound(`No device with id "${request.params.id}".`));
      }
      return reply.code(200).send(device);
    },
  });

  // --- Custody -------------------------------------------------------------

  api.route({
    method: "POST",
    url: "/devices/:id/lease/start",
    preHandler: [...base, custodyRoles],
    schema: {
      tags: ["Offline"],
      summary: "Take custody of this location's allocation (start the lease)",
      description:
        "**This is the fact the lease policy was waiting for.** Task 10.2 stored a per-location `leaseWindowMinutes` and enforced nothing, because nothing yet knew when a lease STARTED. A device taking custody is that moment:\n\n" +
        "* `leaseStartedAt = now`\n" +
        "* `leaseExpiresAt = now + the location's leaseWindowMinutes`\n" +
        "* a **NULL** window yields a **NULL** expiry — FOREVER, which never expires and never freezes.\n\n" +
        "The expiry is a SNAPSHOT of the policy at this moment. An admin editing the location's window afterwards changes the next lease, not this one — the alternative would retroactively expire a till that is mid-shift.\n\n" +
        "Custody moves NO stock and posts nothing: the location already owns the stock (that was the allocation). This records that a device is now answerable for it.\n\n" +
        "**409** for a SUSPENDED or RETIRED device. It may still sync what it already captured; it may not be handed a fresh window to sell in.",
      security: SECURE,
      params: z.object({ id: z.string().min(1) }),
      response: { 200: zPosDevice, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      try {
        const device = await startLease(request.tenantDb, request.params.id);
        return reply.code(200).send(device);
      } catch (error) {
        if (error instanceof DeviceValidationError && /^Unknown device/.test(error.message)) {
          return reply.code(404).send(notFound(error.message));
        }
        return sendOfflineError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/devices/:id/lease/renew",
    preHandler: [...base, custodyRoles],
    schema: {
      tags: ["Offline"],
      summary: "Renew the lease (take custody again)",
      description:
        "Identical to starting a lease, and deliberately so: a renewal IS taking custody again. The clock restarts from the moment the device last proved it was there, not from some earlier grant, and it re-reads the location's CURRENT window.",
      security: SECURE,
      params: z.object({ id: z.string().min(1) }),
      response: { 200: zPosDevice, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      try {
        const device = await renewLease(request.tenantDb, request.params.id);
        return reply.code(200).send(device);
      } catch (error) {
        if (error instanceof DeviceValidationError && /^Unknown device/.test(error.message)) {
          return reply.code(404).send(notFound(error.message));
        }
        return sendOfflineError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/devices/:id/lease/end",
    preHandler: [...base, custodyRoles],
    schema: {
      tags: ["Offline"],
      summary: "Hand in the lease (end custody)",
      description:
        "The clean counterpart to expiry: the device is back on the network, has handed in what it had, and is no longer answerable for a window. It moves no stock — the location still owns whatever it owns — and posts nothing.\n\n" +
        "This is also what UNBLOCKS A PERIOD CLOSE: a device holding no custody can no longer be carrying unsynced sales nobody has accounted for. Sync first, then end the lease, then close the period.",
      security: SECURE,
      params: z.object({ id: z.string().min(1) }),
      response: { 200: zPosDevice, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      try {
        const device = await endLease(request.tenantDb, request.params.id);
        return reply.code(200).send(device);
      } catch (error) {
        if (error instanceof DeviceValidationError && /^Unknown device/.test(error.message)) {
          return reply.code(404).send(notFound(error.message));
        }
        return sendOfflineError(reply, error);
      }
    },
  });

  // --- Sync ----------------------------------------------------------------

  api.route({
    method: "POST",
    url: "/sync",
    preHandler: [...base, syncRoles],
    schema: {
      tags: ["Offline"],
      summary: "Ingest a batch of captured offline sales",
      description:
        "Replays captured sales through the **EXISTING atomic sale transaction** — the same one an online sale uses, under the same database triggers. An offline sale becomes a journal entry only here, on the server, and there is no second posting path.\n\n" +
        "**The selling location comes from the DEVICE**, never from the request. Each capture draws stock from the device's location and is checked against what that location OWNS (Task 3.2-LOC). Because the device only ever sold stock its location already owned — allocated to it before it went offline, and unsellable by any other channel — **the server-side stock re-validation cannot fail in the normal case**: the stock was reserved before the sale was made. There is no shared pool to race for, so there is no conflict to resolve.\n\n" +
        "**ORDER:** oldest `businessTimestamp` first, so periods fill in the order things actually happened.\n\n" +
        "**BUSINESS-TIME POSTING:** each journal entry is DATED to its capture's `businessTimestamp`; `syncedAt` is recorded separately on the sale. The two are never conflated.\n\n" +
        "**IDEMPOTENCY:** a key that has already posted returns `REPLAYED` — no second journal entry, no second stock decrement, no error — so a device may retry freely on a bad connection. A unique index enforces it, not a convention.\n\n" +
        "**CLOSED-PERIOD FALLBACK:** a capture whose own period has already closed posts into the CURRENT open period, with the true date recorded on the sale as `originalBusinessDate` and referenced in the entry's description. The record is never lost and the real date stays auditable.\n\n" +
        "**NEEDS_RESOLUTION:** a capture that cannot post (its shift has closed, its location genuinely cannot cover it, its clock is in the future, both periods are shut) posts NOTHING — no journal entry, no stock movement, nothing negative — and is queued with its exact payload at `GET /v1/offline/needs-resolution`. It is never dropped.\n\n" +
        "**FREEZE RESOLUTION:** if this device's location was frozen by an expired lease, a sync that accounts for everything releases it — the real sales post and the genuinely unsold remainder returns to MAIN as a value-neutral transfer. If ANY capture lands in the queue, the freeze is KEPT: part of the allocation is already spoken for, and returning it to MAIN while holding evidence it was sold is exactly the guess the server refuses to make.\n\n" +
        "One transaction per sale — a batch is a transport convenience, not a unit of work.",
      security: SECURE,
      body: zSyncBody,
      response: { 200: zSyncBatchResult, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;

      const sales: CapturedSaleInput[] = [];
      for (const capture of body.sales) {
        const businessTimestamp = isoDateTimeToUtc(capture.businessTimestamp);
        if (businessTimestamp === null) {
          // Unreachable through the schema (zIsoDateTime validates with this very
          // function); kept so the parse is never assumed to have succeeded.
          return reply
            .code(400)
            .send(
              badRequest(
                `Capture ${capture.idempotencyKey}: businessTimestamp must be an ISO-8601 date-time with an explicit offset or Z.`,
              ),
            );
        }
        sales.push({
          idempotencyKey: capture.idempotencyKey,
          businessTimestamp,
          shiftId: capture.shiftId,
          ...(capture.customerId !== undefined ? { customerId: capture.customerId } : {}),
          ...(capture.reference !== undefined ? { reference: capture.reference } : {}),
          ...(capture.requestEtims === true ? { requestEtims: true } : {}),
          lines: capture.lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            ...(line.discount !== undefined ? { discount: line.discount } : {}),
          })),
          tenders: capture.tenders.map((tender) => ({
            tenderType: tender.tenderType,
            amount: tender.amount,
            ...(tender.mpesaReference !== undefined
              ? { mpesaReference: tender.mpesaReference }
              : {}),
          })),
        });
      }

      try {
        const result = await ingestSyncBatch(request.tenantDb, {
          deviceId: body.deviceId,
          sales,
          syncedBy: auth.userId,
        });
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof SyncValidationError && /^Unknown device/.test(error.message)) {
          return reply.code(404).send(notFound(error.message));
        }
        return sendOfflineError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/sync/status",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Offline"],
      summary: "Per-device sync and lease state, plus frozen-allocation alerts",
      description:
        "The transparency surface. Per device: its custody state, whether its location is FROZEN pending reconciliation, how many of its captures are in the owner's queue, and how many have posted.\n\n" +
        "`activeFreezes` is the admin's alert feed for frozen allocation, with the per-product detail of what each freeze holds. **This is DATA, not delivery** — push/email/SMS is a later notifications module, exactly as with the low-stock feed.",
      security: SECURE,
      response: {
        200: z.object({
          devices: z.array(zDeviceSyncStatus),
          activeFreezes: z.array(zStockFreezeDetail),
          activeFreezeCount: z.number().int(),
          needsResolutionTotal: z.number().int(),
        }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (request, reply) => {
      const devices = await listDevices(request.tenantDb);
      const [status, activeFreezes] = await Promise.all([
        getSyncStatus(request.tenantDb, devices),
        listActiveFreezeDetails(request.tenantDb),
      ]);
      return reply.code(200).send({
        devices: status.devices,
        activeFreezes,
        activeFreezeCount: activeFreezes.length,
        needsResolutionTotal: status.needsResolutionTotal,
      });
    },
  });

  // --- Resolution ----------------------------------------------------------

  api.route({
    method: "POST",
    url: "/devices/:id/write-off",
    preHandler: [...base, adminRoles],
    schema: {
      tags: ["Offline"],
      summary: "Write off a device's frozen allocation (lost, stolen or dead device)",
      description:
        "The one-click admin resolution for a freeze that will never resolve itself. **This is the ONLY path by which frozen stock becomes a general-ledger event.**\n\n" +
        "One `WRITE_OFF` movement per frozen product slice, each posting **Dr 5300 Inventory Write-offs / Cr 1200 Inventory** at carrying value — the ordinary outbound path through the inventory service, with no special valuation and no new accounts. `sum(Product.stockValue) = GL(1200)` still holds after the loss is taken, because the credit to 1200 IS the reduction in stockValue (one valuation event per movement).\n\n" +
        "ONE transaction: the movements, the journal entries and the freeze's resolution commit together. The caller's user id is recorded as `resolvedBy` — an accounting loss always names the person who decided to take it.\n\n" +
        "**409** if the device's location holds no live freeze (for instance because the device has since synced, which released it automatically).",
      security: SECURE,
      params: z.object({ id: z.string().min(1) }),
      body: zWriteOffBody,
      response: { 200: zWriteOffResult, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const device = await getDevice(request.tenantDb, request.params.id);
      if (device === null) {
        return reply.code(404).send(notFound(`No device with id "${request.params.id}".`));
      }
      const freeze = await getActiveFreezeForLocation(request.tenantDb, device.locationId);
      if (freeze === null) {
        return reply
          .code(409)
          .send(
            conflict(
              `Device ${device.deviceName} (${device.locationCode}) holds no frozen allocation. If it has synced since its lease expired, the freeze was already released and its real sales have posted.`,
            ),
          );
      }
      try {
        const result = await writeOffFrozenStock(
          request.tenantDb,
          freeze.id,
          request.body.reason,
          auth.userId,
        );
        request.log.warn(
          {
            userId: auth.userId,
            deviceId: device.id,
            freezeId: freeze.id,
            totalWrittenOff: result.totalWrittenOff.toString(),
          },
          "frozen allocation written off to 5300",
        );
        return reply.code(200).send(result);
      } catch (error) {
        return sendOfflineError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/needs-resolution",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Offline"],
      summary: "Captured sales that could not post",
      description:
        "The owner's queue, oldest business time first. **Nothing in here has had any financial effect** — no journal entry, no stock movement, no sale — so nothing in here can be making a balance wrong. They are sales that HAPPENED and have not yet been recorded, which is a different and visible problem.\n\n" +
        "Each row carries the exact captured payload that was attempted and the reason it could not post. A capture in this queue is NOT consumed: re-sending the same `idempotencyKey` is allowed to try again, which is how the queue clears itself once the blocking condition (a freeze, a closed shift, a shut period) is gone.",
      security: SECURE,
      querystring: z.object({ deviceId: z.string().min(1).optional() }),
      response: {
        200: z.object({ data: z.array(zNeedsResolutionRow), count: z.number().int() }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { deviceId } = request.query;
      const data = await listNeedsResolution(request.tenantDb, {
        ...(deviceId !== undefined ? { deviceId } : {}),
      });
      return reply.code(200).send({ data, count: data.length });
    },
  });
}
