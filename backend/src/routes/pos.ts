import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { platformDb } from "../db/platform";
import { parseMoneyToCents as parseMoney } from "../lib/money";
import {
  openShift,
  closeShift,
  getCurrentShift,
  getShiftSummary,
  ShiftValidationError,
} from "../services/shifts";
import {
  recordSale,
  voidSale,
  getSale,
  listSales,
  SaleValidationError,
  type SaleLineInput,
  type SaleTenderInput,
} from "../services/sales";
import { buildReceipt } from "../services/receipt";
import { InsufficientStockError, InventoryValidationError } from "../services/inventory";
import { PeriodClosedError, LedgerValidationError } from "../services/ledger";
import {
  EtimsNotConfiguredError,
  EtimsStateError,
  EtimsValidationError,
  signSaleInvoice,
} from "../services/etims/etims-signing";
import {
  zEtimsSaleNote,
  zReceipt,
  zSaleResult,
  zShiftSummary,
  zTenderType,
} from "../schemas/models";
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
  zPaginationResult,
  zPaginationWithDefault,
  zQuantity,
} from "../schemas/common";

const zSaleLineBody = z.object({
  productId: z.string().min(1, "productId is required."),
  quantity: zQuantity,
  discount: zMoneyNonNegative.optional(),
});

const zSaleTenderBody = z.object({
  tenderType: zTenderType,
  amount: zMoneyNonNegative,
  mpesaReference: z.string().min(1).optional(),
});

const zSaleCreate = z.object({
  shiftId: z.string().min(1, "shiftId is required."),
  customerId: z.string().optional(),
  reference: z.string().optional(),
  sellingLocationId: z.string().min(1).optional().meta({
    description:
      "Which location is selling. Omit for the tenant's MAIN pool — the behaviour before this field existed. The sale draws from THIS location's OWNED stock, so it is refused with 400 if this location lacks the quantity even when the tenant holds plenty elsewhere. Recorded on the sale so a void returns the goods here.",
  }),
  requestEtims: z.boolean().optional().meta({
    description:
      "**THE PER-SALE KRA eTIMS OPT-IN (Task 4.1).** Set it when the customer wants a KRA fiscal invoice — usually because they will claim the expense, which is why a buyer PIN normally accompanies it.\n\n" +
      "**Omit it for the ordinary sale.** Most MSME sales are informal, carry no buyer PIN and are validly finalized with no fiscal invoice: `fiscalStatus` stays NOT_REQUESTED and nothing is sent to KRA. The system never auto-submits every sale.\n\n" +
      "When set, the sale is recorded and committed FIRST and the invoice is signed AFTERWARDS, outside the sale transaction. **A signing failure never fails the sale** — the response still reports 201 with the sale, plus an `etims` note saying what happened. eTIMS posts nothing to the ledger: the VAT was already posted at sale time.",
  }),
  lines: z.array(zSaleLineBody).min(1, "lines must be a non-empty array."),
  tenders: z.array(zSaleTenderBody).min(1, "tenders must be a non-empty array."),
});

const zSaleCreateResult = zSaleResult.extend({
  etims: zEtimsSaleNote.nullable().meta({
    description:
      "Present only when requestEtims was set. Null for the ordinary sale, which asked for no fiscal invoice.",
  }),
});

const zVoidResult = zSaleResult.extend({
  creditNote: z
    .object({
      invoiceId: z.string(),
      etimsInvoiceNumber: z.number().int(),
    })
    .nullable()
    .meta({
      description:
        "Set ONLY when the voided sale had been fiscally SIGNED by KRA. Voiding such a sale OWES KRA a credit note — a filed invoice for a sale that did not happen is declared revenue the business never earned — so the obligation is recorded atomically with the void. It is not submitted here: a refund at the counter must never wait on KRA being reachable. Push it with POST /v1/etims/invoices/:id/retry. Null for the ordinary void of an unsigned sale, which owes nothing.",
    }),
});

// Insufficient stock, a closed period, credit-limit breaches and shift-state
// rules are all STATE-dependent — they depend on rows in the database, not the
// request's shape — so they cannot live in a schema. They stay in the sale,
// shift, inventory and ledger services and surface here as 400/409.
function sendPosError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PeriodClosedError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (
    error instanceof SaleValidationError ||
    error instanceof ShiftValidationError ||
    error instanceof InsufficientStockError ||
    error instanceof InventoryValidationError ||
    error instanceof LedgerValidationError
  ) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

function buildSaleInputs(body: z.infer<typeof zSaleCreate>): {
  lines: SaleLineInput[];
  tenders: SaleTenderInput[];
} {
  const lines: SaleLineInput[] = body.lines.map((raw) => ({
    productId: raw.productId,
    quantity: raw.quantity,
    ...(raw.discount !== undefined ? { discount: raw.discount } : {}),
  }));
  const tenders: SaleTenderInput[] = body.tenders.map((raw) => ({
    tenderType: raw.tenderType,
    amount: raw.amount,
    ...(raw.mpesaReference !== undefined ? { mpesaReference: raw.mpesaReference } : {}),
  }));
  return { lines, tenders };
}

/**
 * Sign an ALREADY-COMMITTED sale, and never let the attempt affect the sale.
 *
 * Every expected eTIMS failure is caught and turned into a NOTE: the tenant has
 * not configured eTIMS, KRA rejected the payload, KRA was unreachable. The sale is
 * done and the customer has their goods — refusing the response at this point
 * would tell the cashier a successful sale had failed, which is worse than an
 * unsigned invoice they can see and fix.
 *
 * Only genuinely unexpected errors propagate, because those are bugs.
 */
async function signCommittedSale(
  db: Parameters<typeof signSaleInvoice>[0],
  saleId: string,
  userId: string,
): Promise<z.infer<typeof zEtimsSaleNote>> {
  try {
    const signed = await signSaleInvoice(db, saleId, userId);
    return {
      requested: true,
      attempted: true,
      fiscalStatus: signed.fiscalStatus,
      invoiceId: signed.invoice.id,
      etimsInvoiceNumber: signed.invoice.etimsInvoiceNumber,
      note:
        signed.fiscalStatus === "SIGNED"
          ? null
          : (signed.invoice.resultMsg ??
            "eTIMS did not sign this invoice; see GET /v1/etims/invoices."),
    };
  } catch (error) {
    if (
      error instanceof EtimsNotConfiguredError ||
      error instanceof EtimsValidationError ||
      error instanceof EtimsStateError
    ) {
      return {
        requested: true,
        attempted: false,
        // The sale keeps the PENDING_ETIMS it was committed with: a KRA invoice
        // WAS asked for and has not been produced, which is the honest state and
        // keeps it visible on the operator's dashboard.
        fiscalStatus: "PENDING_ETIMS",
        invoiceId: null,
        etimsInvoiceNumber: null,
        note: error.message,
      };
    }
    throw error;
  }
}

export async function posRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];
  const tillRoles = app.requireRole("CASHIER", "MSME_MANAGER", "MSME_OWNER");
  const readRoles = app.requireRole(
    "CASHIER",
    "MSME_MANAGER",
    "MSME_OWNER",
    "ACCOUNTANT",
    "VIEWER_AUDITOR",
  );
  const voidRoles = app.requireRole("MSME_MANAGER", "MSME_OWNER");

  // --- Shifts ---
  api.route({
    method: "POST",
    url: "/shifts/open",
    preHandler: [...base, tillRoles],
    schema: {
      tags: ["POS"],
      summary: "Open a till shift",
      description:
        "A cashier may have only one open shift at a time. openingFloat is a decimal string of counted cash.",
      security: SECURE,
      body: z.object({ openingFloat: zMoneyNonNegative }),
      response: { 201: zShiftSummary, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const shift = await openShift(
          request.tenantDb,
          auth.userId,
          parseMoney(request.body.openingFloat),
        );
        return reply.code(201).send(shift);
      } catch (error) {
        return sendPosError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/shifts/:id/close",
    preHandler: [...base, tillRoles],
    schema: {
      tags: ["POS"],
      summary: "Close a till shift and compute the cash variance",
      description:
        "expectedCash = openingFloat + cash taken - cash refunded; variance = closingFloat - expectedCash (signed).",
      security: SECURE,
      params: zIdParam,
      body: z.object({ closingFloat: zMoneyNonNegative }),
      response: { 200: zShiftSummary, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const shift = await closeShift(
          request.tenantDb,
          request.params.id,
          parseMoney(request.body.closingFloat),
          auth.userId,
        );
        return reply.code(200).send(shift);
      } catch (error) {
        return sendPosError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/shifts/current",
    preHandler: [...base, tillRoles],
    schema: {
      tags: ["POS"],
      summary: "The caller's currently open shift",
      security: SECURE,
      response: { 200: zShiftSummary, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const shift = await getCurrentShift(request.tenantDb, auth.userId);
      if (shift === null) {
        return reply.code(404).send(notFound("No open shift for this cashier."));
      }
      return reply.code(200).send(shift);
    },
  });

  api.route({
    method: "GET",
    url: "/shifts/:id/summary",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["POS"],
      summary: "Shift summary with tender breakdown",
      security: SECURE,
      params: zIdParam,
      response: { 200: zShiftSummary, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const summary = await getShiftSummary(request.tenantDb, id);
      if (summary === null) {
        return reply.code(404).send(notFound(`No shift with id "${id}".`));
      }
      return reply.code(200).send(summary);
    },
  });

  // --- Sales ---
  api.route({
    method: "POST",
    url: "/sales",
    preHandler: [...base, tillRoles],
    schema: {
      tags: ["POS"],
      summary: "Record a sale",
      description:
        "Decrements stock, posts COGS and revenue through the ledger, and records tenders — all in one transaction. An MPESA tender is created PENDING and settles to 1015 M-Pesa Clearing until its STK callback confirms it. quantity, discount and amount are decimal strings.\n\n" +
        "**The sale draws from a selling location.** `sellingLocationId` defaults to the tenant's MAIN pool, so a request that omits it behaves exactly as before. Stock comes out of that location's OWNED quantity and is checked against it — **a till holding 5 cannot sell 6 even when the warehouse holds 500**, because a location sells only what it owns. That refusal is a 400 naming the location, the requested quantity and the owned quantity.\n\n" +
        "Valuation is unaffected: COGS still derives from the product's tenant-wide authoritative stockValue, and a location running dry while the tenant still holds stock is an ordinary partial movement, not a depletion.",
      security: SECURE,
      body: zSaleCreate,
      response: { 201: zSaleCreateResult, ...errorResponses(400, 401, 403, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      const inputs = buildSaleInputs(body);

      try {
        const sale = await recordSale(request.tenantDb, {
          shiftId: body.shiftId,
          ...(body.customerId !== undefined ? { customerId: body.customerId } : {}),
          ...(body.reference !== undefined ? { reference: body.reference } : {}),
          ...(body.sellingLocationId !== undefined
            ? { sellingLocationId: body.sellingLocationId }
            : {}),
          ...(body.requestEtims === true ? { requestEtims: true } : {}),
          lines: inputs.lines,
          tenders: inputs.tenders,
          createdBy: auth.userId,
        });

        // ---- eTIMS, STRICTLY AFTER THE SALE HAS COMMITTED --------------------
        //
        // recordSale has returned, so the sale is final: stock moved, COGS and
        // revenue posted, tenders recorded. Nothing below can undo any of it.
        // That ordering is the whole point — if signing ran inside the sale
        // transaction, a KRA outage would roll back a sale the customer has
        // already paid for and walked away from.
        const etims =
          body.requestEtims === true
            ? await signCommittedSale(request.tenantDb, sale.id, auth.userId)
            : null;

        // The sale's fiscalStatus was set to PENDING_ETIMS inside the
        // transaction and may have moved since; report the authoritative value
        // rather than the one read before signing.
        return reply.code(201).send({
          ...sale,
          ...(etims !== null && etims.attempted ? { fiscalStatus: etims.fiscalStatus } : {}),
          etims,
        });
      } catch (error) {
        return sendPosError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/sales/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["POS"],
      summary: "Get one sale with its lines and tenders",
      security: SECURE,
      params: zIdParam,
      response: { 200: zSaleResult, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const sale = await getSale(request.tenantDb, id);
      if (sale === null) {
        return reply.code(404).send(notFound(`No sale with id "${id}".`));
      }
      return reply.code(200).send(sale);
    },
  });

  api.route({
    method: "GET",
    url: "/sales/:id/receipt",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["POS"],
      summary: "Render a sale's receipt",
      description:
        "Includes the business header, VAT summary, tenders and change due. The etims block is the KRA fiscal-signing seam (Task 4.x) and is null until a sale is signed.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zReceipt, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null || auth.tenantId === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const { id } = request.params;
      const tenant = await platformDb.tenant.findUnique({
        where: { id: auth.tenantId },
        select: { name: true, subdomain: true, kraPin: true },
      });
      if (tenant === null) {
        return reply.code(404).send(notFound("Tenant not found."));
      }
      const receipt = await buildReceipt(request.tenantDb, id, {
        name: tenant.name,
        subdomain: tenant.subdomain,
        kraPin: tenant.kraPin,
      });
      if (receipt === null) {
        return reply.code(404).send(notFound(`No sale with id "${id}".`));
      }
      return reply.code(200).send(receipt);
    },
  });

  api.route({
    method: "POST",
    url: "/sales/:id/void",
    preHandler: [...base, voidRoles],
    schema: {
      tags: ["POS"],
      summary: "Void a sale",
      description:
        "Posts a reversing journal entry and returns the stock at the ORIGINAL movement's unit cost, to the location it came from. The sale row itself is never edited.\n\n" +
        "**If the sale had been fiscally SIGNED by KRA, the void records a CREDIT-NOTE OBLIGATION** (`creditNote` in the response), atomically with the void. A filed invoice for a sale that did not happen is declared revenue the business never earned, so the reversal is never silently dropped. It is recorded, not submitted — a refund must not wait on KRA being reachable.",
      security: SECURE,
      params: zIdParam,
      body: z.object({ reason: z.string().trim().min(1, "reason is required.") }),
      response: { 200: zVoidResult, ...errorResponses(400, 401, 403, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const voided = await voidSale(
          request.tenantDb,
          request.params.id,
          request.body.reason,
          auth.userId,
        );
        if (voided.creditNote !== null) {
          request.log.warn(
            {
              saleId: request.params.id,
              creditNoteInvoiceId: voided.creditNote.invoiceId,
              etimsInvoiceNumber: voided.creditNote.etimsInvoiceNumber,
            },
            "voided a fiscally SIGNED sale: a KRA credit note is owed and has been recorded",
          );
        }
        return reply.code(200).send({ ...voided.sale, creditNote: voided.creditNote });
      } catch (error) {
        return sendPosError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/sales",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["POS"],
      summary: "List sales",
      security: SECURE,
      querystring: zPaginationWithDefault(25).extend({
        from: zIsoDate.optional(),
        to: zIsoDate.optional(),
        shiftId: z.string().optional(),
      }),
      response: {
        200: z.object({ data: z.array(zSaleResult), pagination: zPaginationResult }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { from, to, shiftId, take, skip } = request.query;
      const filters: Parameters<typeof listSales>[1] = { take, skip };

      if (from !== undefined) {
        const parsed = isoDateToUtc(from);
        if (parsed === null) {
          return reply.code(400).send(badRequest("from must be YYYY-MM-DD."));
        }
        filters.from = parsed;
      }
      if (to !== undefined) {
        const parsed = isoDateToUtc(to);
        if (parsed === null) {
          return reply.code(400).send(badRequest("to must be YYYY-MM-DD."));
        }
        filters.to = parsed;
      }
      if (shiftId !== undefined && shiftId !== "") {
        filters.shiftId = shiftId;
      }

      const result = await listSales(request.tenantDb, filters);
      return reply.code(200).send(result);
    },
  });
}
