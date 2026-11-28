// ===========================================================================
// Accounts receivable routes — customer receipts, aging and statements
// (Module 6, Task 6).
//
// These routes authorise and delegate. All receipt and allocation state goes
// through src/services/receivables.ts, which is their sole writer and the only
// poster of the AR-settlement general ledger. No route here writes a stock table,
// and nothing in this module posts to account 1200 or to any revenue or VAT
// account — the sale recognised both at the till.
//
// Money is cents as STRINGS in and out. A JSON number in a money field is rejected
// by the schema, because a number can lose precision before it ever reaches us.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { parseMoneyToCents } from "../lib/money";
import {
  getArAging,
  getCustomerReceipt,
  getCustomerStatement,
  listCustomerReceipts,
  listOpenCreditSales,
  recordCustomerReceipt,
  ReceivablesStateError,
  ReceivablesValidationError,
  type ReceiptAllocationInput,
} from "../services/receivables";
import { LedgerValidationError, PeriodClosedError } from "../services/ledger";
import {
  zArAging,
  zCustomerReceipt,
  zCustomerReceiptDetail,
  zCustomerReceiptMethod,
  zCustomerStatement,
  zOpenCreditSale,
} from "../schemas/models";
import {
  badRequest,
  conflict,
  errorBody,
  errorResponses,
  isoDateToUtc,
  notFound,
  SECURE,
  zCentsString,
  zIdParam,
  zIsoDate,
  zMoneyNonNegative,
} from "../schemas/common";

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

const zReceiptBody = z.object({
  customerId: z.string().min(1, "customerId is required.").meta({
    description:
      "REQUIRED, unlike a sale's customer. Money received against a receivable is by definition received from the person who owes it; an unattributed receipt could not reduce anybody's balance and would put the customer subledger out of step with GL 1100.",
  }),
  receiptDate: zIsoDate.meta({
    description: "The date the money arrived. **The journal entry is dated to it**, not to today.",
  }),
  method: zCustomerReceiptMethod.meta({
    description:
      "What selects the debit account: CASH -> 1000, BANK -> 1020, MPESA -> 1010. **MPESA RECORDS, IT DOES NOT COLLECT** — nothing is requested from Safaricom; this is the record of a payment the customer already made.",
  }),
  amount: zMoneyNonNegative.meta({
    description: "The amount that arrived, as a decimal money string. Must be positive.",
  }),
  reference: z.string().min(1).optional().meta({
    description: "The external reference: an M-Pesa code, a cheque number, a bank transfer ref.",
  }),
  notes: z.string().min(1).optional(),
  allocations: z
    .array(
      z.object({
        saleId: z.string().min(1, "saleId is required."),
        amount: zMoneyNonNegative,
      }),
    )
    .min(1, "A receipt must be allocated to at least one credit sale.")
    .meta({
      description:
        "Which credit sales this receipt settles — use `GET /v1/receivables/open` to find them. **The amounts MUST sum to the receipt exactly**: there is no on-account customer balance in this build, so every shilling is pointed at a sale. An unallocated remainder would leave the customer's balance overstated while the aging report kept chasing someone who has paid. The service refuses a mismatch and DEFERRED database constraints — bound to BOTH the receipt and its allocations — refuse it at COMMIT.",
    }),
});

// State-dependent rules — is this sale a credit sale, is anything still owed on it,
// is the period open — depend on rows in the database rather than on the shape of the
// request, so they stay in the service and surface here.
function sendReceivablesError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ReceivablesStateError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof PeriodClosedError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof ReceivablesValidationError || error instanceof LedgerValidationError) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

/** A validated YYYY-MM-DD is already known to parse; this keeps the type honest. */
function requireDate(value: string, field: string): Date {
  const parsed = isoDateToUtc(value);
  if (parsed === null) {
    throw new ReceivablesValidationError(`${field} must be YYYY-MM-DD.`);
  }
  return parsed;
}

function buildAllocations(
  raw: ReadonlyArray<{ saleId: string; amount: string }>,
): ReceiptAllocationInput[] {
  return raw.map((allocation) => ({
    saleId: allocation.saleId,
    amount: parseMoneyToCents(allocation.amount),
  }));
}

export async function receivablesRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];

  // WHY CASHIER IS NOT HERE, and it is a reconciliation reason rather than an RBAC
  // preference. A shift's `expectedCash` is computed as
  // `openingFloat + cash sales - cash refunds` (src/services/shifts.ts) — it is
  // derived from the shift's SALES and knows nothing else. A cashier recording a CASH
  // receipt at the till would put real money in the drawer that the formula cannot
  // see, so every such shift would close with a phantom overage and a counted
  // variance that means nothing. That is the same failure the engineering ledger records for
  // posting a cash sale into a closed shift, and it is not worth creating.
  //
  // Taking customer receipts is therefore a back-office operation: the cash is the
  // business's (1000 Cash on Hand), not the till's float. Letting a cashier do it
  // later is a MODULE 3 change — fold receipts into `expectedCash` — not an entry in
  // this list.
  const receiptRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT");
  const readRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "ACCOUNTANT",
    "VIEWER_AUDITOR",
  );

  // --- The allocation worklist ---------------------------------------------

  api.route({
    method: "GET",
    url: "/open",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Receivables"],
      summary: "Open credit sales — what each customer still owes, oldest first",
      description:
        "The worklist a receipt is allocated against. Each row's `outstanding` is `SUM(the sale's CREDIT tenders) - arReceived`.\n\n" +
        "**THE RECEIVABLE IS DERIVED, NEVER STORED.** Sale tenders are write-once, so totalling them cannot go stale, and there is deliberately no second column that could disagree with the tenders it claims to total.\n\n" +
        "Only COMPLETED sales appear: a VOIDED sale's receivable was reversed. Because a sale that has been collected against cannot be voided, those two rules close the loop from both ends — you cannot void a collected sale, and you cannot collect a voided one.",
      security: SECURE,
      querystring: z.object({
        customerId: z.string().min(1).optional(),
        asOf: zIsoDate.optional().meta({
          description: "The day `daysOutstanding` is measured to. Defaults to today.",
        }),
      }),
      response: {
        200: z.object({
          data: z.array(zOpenCreditSale),
          count: z.number().int(),
          totalOutstanding: zCentsString,
        }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { customerId, asOf } = request.query;
      const data = await listOpenCreditSales(request.tenantDb, {
        ...(customerId !== undefined ? { customerId } : {}),
        ...(asOf !== undefined ? { asOf: requireDate(asOf, "asOf") } : {}),
      });
      const totalOutstanding = data.reduce((sum, row) => sum + row.outstanding, 0n);
      return reply.code(200).send({ data, count: data.length, totalOutstanding });
    },
  });

  // --- Receipts ------------------------------------------------------------

  api.route({
    method: "POST",
    url: "/receipts",
    preHandler: [...base, receiptRoles],
    schema: {
      tags: ["Receivables"],
      summary: "Record a receipt from a customer, allocated against their credit sales",
      description:
        "Posts, in ONE transaction:\n\n" +
        "```\nDr 1000 Cash | 1020 Bank | 1010 M-Pesa Till    the money that arrived\nCr 1100 Accounts Receivable                    the debt it settles\n```\n\n" +
        "and in the same transaction raises each allocated sale's `arReceived` and lowers the customer's `creditBalance` by the receipt amount.\n\n" +
        "**NOTHING ABOUT REVENUE IS TOUCHED.** The sale recognised its income and its output VAT at the till; a receipt that posted to either would recognise the same sale's revenue twice and declare the same tax twice to KRA. This is one asset becoming another.\n\n" +
        "**Every shilling must be allocated**, and the allocations must sum to the receipt exactly: there is no on-account customer balance in this build. An allocation may never exceed a sale's outstanding credit, a sale with no CREDIT tender cannot be allocated to (it was settled at the till), and a fully settled sale cannot be collected against again.\n\n" +
        "**A receipt is an IMMUTABLE posted fact**: the database refuses UPDATE and DELETE on it and on its allocations. One consequence worth knowing: once a sale has received money it can no longer be VOIDED, because the void would reverse the receivable while the receipt that settled it stood.",
      security: SECURE,
      body: zReceiptBody,
      response: { 201: zCustomerReceipt, ...errorResponses(400, 401, 403, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      try {
        const receipt = await recordCustomerReceipt(request.tenantDb, {
          customerId: body.customerId,
          receiptDate: requireDate(body.receiptDate, "receiptDate"),
          method: body.method,
          amount: parseMoneyToCents(body.amount),
          ...(body.reference !== undefined ? { reference: body.reference } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          allocations: buildAllocations(body.allocations),
          createdById: auth.userId,
        });
        return reply.code(201).send(receipt);
      } catch (error) {
        return sendReceivablesError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/receipts",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Receivables"],
      summary: "List customer receipts with their allocations",
      description: "Newest receipt number first. Filter by customer, method or date range.",
      security: SECURE,
      querystring: z.object({
        customerId: z.string().min(1).optional(),
        method: zCustomerReceiptMethod.optional(),
        from: zIsoDate.optional(),
        to: zIsoDate.optional(),
      }),
      response: {
        200: z.object({
          data: z.array(zCustomerReceipt),
          count: z.number().int(),
          totalReceived: zCentsString,
        }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { customerId, method, from, to } = request.query;
      const data = await listCustomerReceipts(request.tenantDb, {
        ...(customerId !== undefined ? { customerId } : {}),
        ...(method !== undefined ? { method } : {}),
        ...(from !== undefined ? { from: requireDate(from, "from") } : {}),
        ...(to !== undefined ? { to: requireDate(to, "to") } : {}),
      });
      const totalReceived = data.reduce((sum, row) => sum + row.amount, 0n);
      return reply.code(200).send({ data, count: data.length, totalReceived });
    },
  });

  api.route({
    method: "GET",
    url: "/receipts/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Receivables"],
      summary: "Get one customer receipt with its allocations",
      description:
        "Includes the journal entry that posted it, derived from the entry's own sourceId rather than stored, so there is no second copy of the link to fall out of step.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zCustomerReceiptDetail, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const receipt = await getCustomerReceipt(request.tenantDb, request.params.id);
      if (receipt === null) {
        return reply
          .code(404)
          .send(notFound(`No customer receipt with id "${request.params.id}".`));
      }
      return reply.code(200).send(receipt);
    },
  });

  // --- Reports -------------------------------------------------------------

  api.route({
    method: "GET",
    url: "/aging",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Receivables"],
      summary: "Accounts receivable aging, bucketed by sale date, per customer",
      description:
        "Buckets: current (raised today), 1-30, 31-60, 61-90 and over 90 days, over each open credit sale's outstanding amount.\n\n" +
        "**AGED BY SALE DATE RATHER THAN A DUE DATE**, and that is a scope decision rather than an oversight: `Customer` carries no payment terms, so there is no due date to age from and inventing one would bake a guess into live data. An offline sale ages from its `businessTimestamp` — when the customer actually took the goods — not from when it synced.\n\n" +
        "Built from the SAME derivation as `GET /open`, so the report and the allocation worklist can never disagree about what is owed. Each row carries the customer's own `creditBalance` column beside its `total`: **the two are equal**, and that is the subledger invariant this module is accountable for.\n\n" +
        "`grandTotal` equals `SUM(Customer.creditBalance)`, and both equal `GL(1100)` **minus the M-Pesa-failure residual** — the receivable a failed or timed-out STK Push posted to 1100 with no customer attribution (Task 3.3). That residual is reported separately rather than plumbed into the subledger, because re-plumbing it would change a settled guarantee.",
      security: SECURE,
      querystring: z.object({
        asOf: zIsoDate.optional().meta({ description: "The day ages are measured to. Defaults to today." }),
      }),
      response: { 200: zArAging, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const { asOf } = request.query;
      const report = await getArAging(
        request.tenantDb,
        asOf !== undefined ? requireDate(asOf, "asOf") : undefined,
      );
      return reply.code(200).send(report);
    },
  });

  api.route({
    method: "GET",
    url: "/customers/:id/statement",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Receivables"],
      summary: "Customer statement — credit sales and receipts with a running balance",
      description:
        "Date order, sales before receipts within a day (the debt is incurred before it is settled, so a same-day pair reads correctly rather than showing a transient negative balance).\n\n" +
        "**Only the CREDIT PORTION of each sale appears**, never the sale total: a sale paid half in cash put only the credit half on the customer's account, and charging the whole thing would make the closing balance disagree with `creditBalance`.\n\n" +
        "VOIDED sales are excluded — the void reversed both the receivable and the balance, so showing the charge without the reversal would break the tie-up, and a statement that does not reconcile is worth nothing. `closingBalance` equals `creditBalance` and this customer's slice of the aging report.",
      security: SECURE,
      params: zIdParam,
      querystring: z.object({ asOf: zIsoDate.optional() }),
      response: { 200: zCustomerStatement, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { asOf } = request.query;
      const statement = await getCustomerStatement(
        request.tenantDb,
        request.params.id,
        asOf !== undefined ? requireDate(asOf, "asOf") : undefined,
      );
      if (statement === null) {
        return reply.code(404).send(notFound(`No customer with id "${request.params.id}".`));
      }
      return reply.code(200).send(statement);
    },
  });
}
