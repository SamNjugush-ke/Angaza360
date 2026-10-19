// ===========================================================================
// Accounts payable routes — supplier bills, payments and aging (Module 7, Task 5.2).
//
// These routes authorise and delegate. All bill, payment and allocation state goes
// through src/services/payables.ts, which is their sole writer and the only poster
// of the AP-settlement general ledger. No route here writes a stock table, and
// nothing in this module posts to account 1200.
//
// Money is cents as STRINGS in and out; quantities and VAT rates are decimal
// strings. A JSON number in a money field is rejected by the schema, because a
// number can lose precision before it ever reaches us.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { parseMoneyToCents } from "../lib/money";
import {
  cancelSupplierBill,
  createSupplierBill,
  getApAging,
  getSupplierBill,
  getSupplierPayment,
  getSupplierStatement,
  listSupplierBills,
  listSupplierPayments,
  postSupplierBill,
  recordSupplierPayment,
  updateSupplierBill,
  PayablesStateError,
  PayablesValidationError,
  type BillLineInput,
  type PaymentAllocationInput,
} from "../services/payables";
import { LedgerValidationError, PeriodClosedError } from "../services/ledger";
import {
  zApAging,
  zSupplierBill,
  zSupplierBillDetail,
  zSupplierBillStatus,
  zSupplierPayment,
  zSupplierPaymentMethod,
  zSupplierStatement,
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
  zQuantityPositive,
} from "../schemas/common";

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

const zBillLineBody = z
  .object({
    description: z.string().trim().min(1, "description is required."),
    quantity: zQuantityPositive,
    unitCost: zMoneyNonNegative.meta({
      description:
        "Cost per unit as a decimal money string. On a PO-matched line this is the NET unit cost the SUPPLIER INVOICED — which need not be the cost the order agreed; the difference is the purchase price variance. On an expense line, quantity x unitCost is the line's net amount, so a lump sum is quantity \"1\" with the whole amount here.",
    }),
    vatRate: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, 'must be a percentage as a decimal string, e.g. "16.00".')
      .optional()
      .meta({
        type: "string",
        examples: ["16.00"],
        description:
          "The VAT percentage the supplier charged on this line, as a decimal STRING matching the Decimal(5,2) column. A RATE, NOT MONEY — never send it as a JSON number and never through a money field. Omitted uses the tenant's default rate. **IGNORED for a non-VAT-registered tenant**, which always records 0.00: there is nothing to recover, and the tax the supplier charged is already part of the line's net cost.",
      }),
    purchaseOrderLineId: z.string().min(1).optional().meta({
      description:
        "PO_MATCH. The purchase order line this invoices, which must belong to the bill's own order. The line CLEARS 2050 GRNI at the price the receipt accrued and advances the line's billed quantity, which can never exceed what was received.",
    }),
    expenseAccountCode: z
      .string()
      .regex(/^\d{4}$/, "must be a 4-digit chart of accounts code.")
      .optional()
      .meta({
        description:
          "EXPENSE. The account to charge, for a cost with nothing received against it. Must exist and be of class EXPENSE, COST_OF_SALES or ASSET. **1200, 2000, 2050, 1400 and 5250 are refused**: inventory moves only through the inventory service, and the other four are this posting's own control accounts.",
      }),
  })
  .refine(
    (line) =>
      (line.purchaseOrderLineId === undefined) !== (line.expenseAccountCode === undefined),
    {
      message:
        "Give exactly one of purchaseOrderLineId (goods received against an order) or expenseAccountCode (a cost with nothing received).",
    },
  );

const zCreateBillBody = z.object({
  supplierId: z.string().min(1, "supplierId is required."),
  billNumber: z.string().trim().min(1, "billNumber is required.").meta({
    description:
      "THE SUPPLIER'S OWN invoice reference, exactly as printed on their document. Unique per supplier — this is the DUPLICATE-PAYMENT GUARD, and a second entry of the same number is refused with 409.",
  }),
  poId: z.string().min(1).optional().meta({
    description:
      "The purchase order this invoice matches. Required if any line is PO-matched; omitted for a standalone expense invoice (rent, electricity, a repair) where nothing was ordered or received.",
  }),
  billDate: zIsoDate.meta({
    description: "The invoice date. **The journal entry is dated to it**, not to today.",
  }),
  dueDate: zIsoDate.optional().meta({
    description:
      "Omitted derives from the supplier's payment terms where those parse (\"Net 30\" -> billDate + 30 days) and otherwise equals billDate — due on receipt. The fallback is deliberately the one that ages the invoice immediately rather than hiding it in \"current\" for a month.",
  }),
  notes: z.string().min(1).optional(),
  lines: z.array(zBillLineBody).min(1, "A supplier bill needs at least one line."),
});

const zUpdateBillBody = z.object({
  billDate: zIsoDate.optional(),
  dueDate: zIsoDate.optional(),
  notes: z.string().nullable().optional(),
  lines: z.array(zBillLineBody).min(1).optional().meta({
    description:
      "Supplied: the line set is REPLACED wholesale. Omitted: lines are untouched. Replacement rather than merge is deliberate — a partial merge needs a per-line identity the client does not have, and guessing one silently drops a quantity change. A DRAFT has cleared no GRNI, so there is nothing to preserve.",
  }),
});

const zCancelBillBody = z.object({
  reason: z.string().trim().min(1, "reason is required.").meta({
    description:
      "Why it is being cancelled. Recorded on the reversing journal entry when the bill had already been posted, so the ledger says why the reversal exists.",
  }),
});

const zPaymentBody = z.object({
  supplierId: z.string().min(1, "supplierId is required."),
  paymentDate: zIsoDate.meta({ description: "The journal entry is dated to this." }),
  method: zSupplierPaymentMethod.meta({
    description:
      "What selects the credit account: CASH -> 1000, BANK -> 1020, MPESA -> 1010. **MPESA RECORDS, IT DOES NOT DISBURSE** — nothing is sent to Safaricom; this is the record of a payment made elsewhere.",
  }),
  amount: zMoneyNonNegative.meta({
    description: "The amount that left, as a decimal money string. Must be positive.",
  }),
  reference: z.string().min(1).optional().meta({
    description: "The external reference: an M-Pesa code, a cheque number, a bank transfer ref.",
  }),
  notes: z.string().min(1).optional(),
  allocations: z
    .array(
      z.object({
        billId: z.string().min(1, "billId is required."),
        amount: zMoneyNonNegative,
      }),
    )
    .min(1, "A payment must be allocated to at least one bill.")
    .meta({
      description:
        "Which invoices this payment settles. **The amounts MUST sum to the payment exactly** — there is no on-account supplier balance in this build, so every shilling is pointed at an invoice. An unallocated remainder would leave Accounts Payable overstated while the aging report kept chasing a supplier who had been paid. The service refuses a mismatch and a DEFERRED database constraint refuses it at COMMIT.",
    }),
});

// State-dependent rules — is this bill still a DRAFT, has the line been received,
// is the period open — depend on rows in the database rather than on the shape of
// the request, so they stay in the service and surface here.
function sendPayablesError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PayablesStateError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof PeriodClosedError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof PayablesValidationError || error instanceof LedgerValidationError) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

/** A validated YYYY-MM-DD is already known to parse; this keeps the type honest. */
function requireDate(value: string, field: string): Date {
  const parsed = isoDateToUtc(value);
  if (parsed === null) {
    throw new PayablesValidationError(`${field} must be YYYY-MM-DD.`);
  }
  return parsed;
}

function buildLines(raw: ReadonlyArray<z.infer<typeof zBillLineBody>>): BillLineInput[] {
  return raw.map((line) => ({
    description: line.description,
    quantity: line.quantity.trim(),
    unitCost: parseMoneyToCents(line.unitCost),
    ...(line.vatRate !== undefined ? { vatRate: line.vatRate.trim() } : {}),
    ...(line.purchaseOrderLineId !== undefined
      ? { purchaseOrderLineId: line.purchaseOrderLineId }
      : {}),
    ...(line.expenseAccountCode !== undefined
      ? { expenseAccountCode: line.expenseAccountCode }
      : {}),
  }));
}

function buildAllocations(
  raw: ReadonlyArray<{ billId: string; amount: string }>,
): PaymentAllocationInput[] {
  return raw.map((allocation) => ({
    billId: allocation.billId,
    amount: parseMoneyToCents(allocation.amount),
  }));
}

export async function payablesRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];

  // Booking what the business owes and deciding who gets paid is the money side of
  // the shop, not stock handling. So unlike procurement — where WAREHOUSE_STAFF can
  // receive a delivery — writing a payable is OWNER/MANAGER only, and ACCOUNTANT is
  // added because entering supplier invoices and settling them IS the accountant's
  // job. CASHIER is deliberately absent from every write: a till operator must
  // never be able to create a creditor or pay one.
  const writeRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT");
  // Approving a payment commits cash. Narrower than entering a bill on purpose.
  const payRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT");
  const readRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "ACCOUNTANT",
    "VIEWER_AUDITOR",
  );

  // --- Bills ---------------------------------------------------------------

  api.route({
    method: "POST",
    url: "/bills",
    preHandler: [...base, writeRoles],
    schema: {
      tags: ["Payables"],
      summary: "Enter a DRAFT supplier bill",
      description:
        "**A DRAFT HAS NO GENERAL-LEDGER EFFECT WHATSOEVER** — no journal entry, no GRNI cleared, no billed quantity advanced. A keyed-in invoice that has not been checked against the delivery is data entry, not a liability, which is exactly why DRAFT is a state and not a flag: a mis-keyed invoice is edited or discarded rather than corrected with a reversing entry.\n\n" +
        "Each line is one of two kinds. A **PO_MATCH** line invoices goods received against a purchase order and will clear 2050 GRNI; its quantity can never exceed what has been received and not yet billed (the three-way match, held by a database CHECK). An **EXPENSE** line charges an account directly for a cost with nothing received against it.\n\n" +
        "`billNumber` is the SUPPLIER'S reference and is unique per supplier: **409 if that invoice has already been entered**, which is the duplicate-payment guard.",
      security: SECURE,
      body: zCreateBillBody,
      response: { 201: zSupplierBill, ...errorResponses(400, 401, 403, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      try {
        const created = await createSupplierBill(request.tenantDb, {
          supplierId: body.supplierId,
          billNumber: body.billNumber,
          ...(body.poId !== undefined ? { poId: body.poId } : {}),
          billDate: requireDate(body.billDate, "billDate"),
          ...(body.dueDate !== undefined
            ? { dueDate: requireDate(body.dueDate, "dueDate") }
            : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          lines: buildLines(body.lines),
          createdById: auth.userId,
        });
        return reply.code(201).send(created);
      } catch (error) {
        return sendPayablesError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/bills",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payables"],
      summary: "List supplier bills",
      description:
        "Newest invoice date first. Filter by status, by supplier, or by `overdue=true` — which means past its due date AND still owed, so a PAID or CANCELLED bill is never overdue however old it is.",
      security: SECURE,
      querystring: z.object({
        status: zSupplierBillStatus.optional(),
        supplierId: z.string().min(1).optional(),
        overdue: z.stringbool().optional().meta({
          description: "True returns only bills past their due date with a balance outstanding.",
        }),
        asOf: zIsoDate.optional().meta({
          description: "The day `overdue` is measured against. Defaults to today.",
        }),
      }),
      response: {
        200: z.object({ data: z.array(zSupplierBill), count: z.number().int() }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { status, supplierId, overdue, asOf } = request.query;
      const data = await listSupplierBills(request.tenantDb, {
        ...(status !== undefined ? { status } : {}),
        ...(supplierId !== undefined ? { supplierId } : {}),
        ...(overdue !== undefined ? { overdue } : {}),
        ...(asOf !== undefined ? { asOf: requireDate(asOf, "asOf") } : {}),
      });
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/bills/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payables"],
      summary: "Get one supplier bill with its lines, GRNI clearing and price variance",
      description:
        "Each PO-matched line reports what it took out of GRNI and the resulting price variance, so an auditor can see the difference between the price the order agreed and the price the supplier invoiced without recomputing it.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zSupplierBillDetail, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const bill = await getSupplierBill(request.tenantDb, request.params.id);
      if (bill === null) {
        return reply.code(404).send(notFound(`No supplier bill with id "${request.params.id}".`));
      }
      return reply.code(200).send(bill);
    },
  });

  api.route({
    method: "PATCH",
    url: "/bills/:id",
    preHandler: [...base, writeRoles],
    schema: {
      tags: ["Payables"],
      summary: "Edit a DRAFT supplier bill",
      description:
        "**409 once the bill has been posted**, and a database trigger refuses it too. A posted bill's figures ARE a journal entry that exists: editing `total` afterwards would leave account 2000 carrying an amount no document supports. Cancel it while it is unpaid, or correct it with a supplier credit note.",
      security: SECURE,
      params: zIdParam,
      body: zUpdateBillBody,
      response: { 200: zSupplierBill, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const body = request.body;
      try {
        const updated = await updateSupplierBill(request.tenantDb, request.params.id, {
          ...(body.billDate !== undefined
            ? { billDate: requireDate(body.billDate, "billDate") }
            : {}),
          ...(body.dueDate !== undefined ? { dueDate: requireDate(body.dueDate, "dueDate") } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.lines !== undefined ? { lines: buildLines(body.lines) } : {}),
        });
        return reply.code(200).send(updated);
      } catch (error) {
        return sendPayablesError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/bills/:id/post",
    preHandler: [...base, writeRoles],
    schema: {
      tags: ["Payables"],
      summary: "Post a DRAFT bill to the ledger",
      description:
        "**This is the operation with the financial effect.** In ONE transaction it posts:\n\n" +
        "```\nDr 2050 GRNI           what the receipts accrued, at the PO price\nDr <expense accounts>  lines with nothing received against them\nDr 1400 VAT Input      the recoverable tax — only now, because a VAT claim needs a tax invoice\nDr/Cr 5250 PPV         invoiced net minus accrued: the price difference\nCr 2000 Accounts Payable   the gross the supplier is owed\n```\n\n" +
        "**The price variance goes to 5250 rather than onto the stock** because the goods may already have been sold: restating their cost would rewrite a margin that has been reported, and in many cases the units no longer exist. Inventory keeps the cost it was received at, and the discrepancy is visible instead of absorbed. **Nothing here touches account 1200 or any stock table.**\n\n" +
        "A line that fully bills its purchase order line clears the ENTIRE remaining GRNI accrual, so the account reaches exactly zero rather than nearly zero — GRNI was accrued receipt by receipt, each rounded once, and that sum cannot be reproduced by re-rounding a total. The residue lands in 5250, which is where a price difference belongs.\n\n" +
        "The entry is dated to `billDate`, so **409 if that accounting period is closed.**",
      security: SECURE,
      params: zIdParam,
      response: { 200: zSupplierBill, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const posted = await postSupplierBill(request.tenantDb, request.params.id, auth.userId);
        return reply.code(200).send(posted);
      } catch (error) {
        return sendPayablesError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/bills/:id/cancel",
    preHandler: [...base, writeRoles],
    schema: {
      tags: ["Payables"],
      summary: "Cancel a bill that has not been paid",
      description:
        "From DRAFT there is nothing to undo. From AWAITING_PAYMENT the bill HAS posted, so cancelling it **REVERSES its journal entry** (a new opposite entry, never an edit — a posted entry is immutable) and **gives the billed quantity back**, because the goods are once again received-and-not-invoiced.\n\n" +
        "**409 once any payment has been allocated.** Money has left the business, so \"this invoice never happened\" is no longer true, and the correction is a supplier credit note.",
      security: SECURE,
      params: zIdParam,
      body: zCancelBillBody,
      response: { 200: zSupplierBill, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const cancelled = await cancelSupplierBill(
          request.tenantDb,
          request.params.id,
          request.body.reason,
          auth.userId,
        );
        return reply.code(200).send(cancelled);
      } catch (error) {
        return sendPayablesError(reply, error);
      }
    },
  });

  // --- Payments ------------------------------------------------------------

  api.route({
    method: "POST",
    url: "/payments",
    preHandler: [...base, payRoles],
    schema: {
      tags: ["Payables"],
      summary: "Record a payment to a supplier, allocated against its bills",
      description:
        "Posts `Dr 2000 Accounts Payable / Cr 1000 | 1020 | 1010` by method, and applies the allocations, in ONE transaction.\n\n" +
        "**Every shilling must be allocated**, and the allocations must sum to the payment exactly: there is no on-account supplier balance in this build. An under-allocated payment would be cash out with no invoice reduced — Accounts Payable left overstated while the aging report kept chasing a supplier who had been paid. A DEFERRED database constraint enforces the equality at COMMIT, so no caller can bypass it.\n\n" +
        "An allocation may never exceed a bill's outstanding balance, a DRAFT bill cannot be paid (it has posted nothing), and a fully PAID bill cannot be paid again — that is the duplicate payment this module exists to prevent.\n\n" +
        "**A payment is an IMMUTABLE posted fact**: the database refuses UPDATE and DELETE on it and on its allocations.",
      security: SECURE,
      body: zPaymentBody,
      response: { 201: zSupplierPayment, ...errorResponses(400, 401, 403, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      try {
        const payment = await recordSupplierPayment(request.tenantDb, {
          supplierId: body.supplierId,
          paymentDate: requireDate(body.paymentDate, "paymentDate"),
          method: body.method,
          amount: parseMoneyToCents(body.amount),
          ...(body.reference !== undefined ? { reference: body.reference } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          allocations: buildAllocations(body.allocations),
          createdById: auth.userId,
        });
        return reply.code(201).send(payment);
      } catch (error) {
        return sendPayablesError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/payments",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payables"],
      summary: "List supplier payments with their allocations",
      description: "Newest payment number first. Filter by supplier.",
      security: SECURE,
      querystring: z.object({ supplierId: z.string().min(1).optional() }),
      response: {
        200: z.object({ data: z.array(zSupplierPayment), count: z.number().int() }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { supplierId } = request.query;
      const data = await listSupplierPayments(
        request.tenantDb,
        supplierId !== undefined ? supplierId : undefined,
      );
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/payments/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payables"],
      summary: "Get one supplier payment",
      security: SECURE,
      params: zIdParam,
      response: { 200: zSupplierPayment, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const payment = await getSupplierPayment(request.tenantDb, request.params.id);
      if (payment === null) {
        return reply
          .code(404)
          .send(notFound(`No supplier payment with id "${request.params.id}".`));
      }
      return reply.code(200).send(payment);
    },
  });

  // --- Reports -------------------------------------------------------------

  api.route({
    method: "GET",
    url: "/aging",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payables"],
      summary: "Accounts payable aging, bucketed by due date, per supplier",
      description:
        "Buckets: current (not yet due), 1-30, 31-60, 61-90 and over 90 days past the DUE date, over the unpaid balance of every posted bill.\n\n" +
        "It buckets by DUE date rather than invoice date because the question an owner is asking is \"what is late\", and an invoice on 60-day terms issued 45 days ago is not late.\n\n" +
        "Only AWAITING_PAYMENT and PARTIALLY_PAID bills appear: a DRAFT posted nothing and is not a liability, a CANCELLED bill has been reversed, and a PAID one is settled. **`grandTotal` is the accounts payable that supplier bills have put into account 2000**, and the two reconciling is the acceptance criterion for this module.",
      security: SECURE,
      querystring: z.object({
        asOf: zIsoDate.optional().meta({ description: "The day ages are measured from. Defaults to today." }),
      }),
      response: { 200: zApAging, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const { asOf } = request.query;
      const report = await getApAging(
        request.tenantDb,
        asOf !== undefined ? requireDate(asOf, "asOf") : undefined,
      );
      return reply.code(200).send(report);
    },
  });

  api.route({
    method: "GET",
    url: "/suppliers/:id/statement",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payables"],
      summary: "Supplier statement — every posted invoice and payment with a running balance",
      description:
        "Date order, invoices before payments within a day (you are charged before you settle, so a same-day pair reads correctly rather than showing a transient negative balance).\n\n" +
        "DRAFT and CANCELLED bills are excluded: a cancelled bill's entry has been REVERSED, so showing the charge without the reversal would make the closing balance disagree with account 2000 — and the whole value of a statement is that it reconciles. `closingBalance` equals this supplier's slice of the aging report.",
      security: SECURE,
      params: zIdParam,
      querystring: z.object({ asOf: zIsoDate.optional() }),
      response: { 200: zSupplierStatement, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { asOf } = request.query;
      const statement = await getSupplierStatement(
        request.tenantDb,
        request.params.id,
        asOf !== undefined ? requireDate(asOf, "asOf") : undefined,
      );
      if (statement === null) {
        return reply.code(404).send(notFound(`No supplier with id "${request.params.id}".`));
      }
      return reply.code(200).send(statement);
    },
  });
}
