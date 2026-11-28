// ===========================================================================
// Expense capture routes (Task T-A9), mounted at /v1/expenses.
//
// MSME_OWNER, MSME_MANAGER and ACCOUNTANT — the people who run the books; reads add
// VIEWER_AUDITOR. CASHIER is refused: paying an expense out of the till would falsify the
// shift's sales-derived expected cash (the same reason a cashier cannot take a receipt).
// Money is a decimal string in and a string of cents out; the date is a business date.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { parseMoneyToCents } from "../lib/money";
import { RATE_LIMITS } from "../plugins/security";
import {
  errorBody,
  errorResponses,
  isoDateToUtc,
  SECURE,
  unauthorized,
  zCentsString,
  zIsoDate,
  zMoney,
  zTimestamp,
  zTimestampNullable,
} from "../schemas/common";
import { ExpenseError, getExpense, listExpenses, recordExpense, voidExpense } from "../services/expenses";

const zPaymentMethod = z.enum(["CASH", "MPESA", "BANK"]).meta({
  description: "How it was PAID: CASH credits 1000, MPESA 1010, BANK 1020. Something bought on credit is a supplier bill, not an expense.",
});

const zExpense = z.object({
  id: z.string(),
  expenseDate: zTimestamp.meta({ description: "The business date (00:00 UTC of that day)." }),
  category: z.string(),
  payee: z.string().nullable(),
  description: z.string(),
  paymentMethod: zPaymentMethod,
  amountCents: zCentsString,
  vatInputCents: zCentsString.meta({ description: "Always 0: input VAT on expenses is not recognised yet." }),
  reference: z.string().nullable(),
  journalEntryId: z.string(),
  isVoided: z.boolean(),
  voidedByEntryId: z.string().nullable(),
  voidedAt: zTimestampNullable,
  voidReason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: zTimestamp,
});

const ERROR_NAMES = { 400: "BadRequest", 404: "NotFound", 409: "Conflict" } as const;

function sendExpenseError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ExpenseError) {
    return reply.code(error.status).send(errorBody(error.status, ERROR_NAMES[error.status], error.message));
  }
  throw error;
}

function businessDate(value: string): Date {
  const date = isoDateToUtc(value);
  if (date === null) {
    throw new ExpenseError(400, "Dates are YYYY-MM-DD.");
  }
  return date;
}

export async function expenseRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];
  const writers = app.requireRole("MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT");
  const readers = app.requireRole("MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "VIEWER_AUDITOR");

  api.route({
    method: "POST",
    url: "/",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [...base, writers],
    schema: {
      tags: ["Expenses"],
      summary: "Record a paid expense",
      description:
        "Posts ONE balanced journal entry in the same transaction: Dr the chosen operating-expense account (6000–6999; not 6020/6025 payroll, 6090 depreciation or 6110 Turnover Tax) / Cr where the money left from (CASH 1000, MPESA 1010, BANK 1020). Posts GROSS: input VAT on expenses is not recognised yet. Dated to `expenseDate`; a closed period is 409.",
      security: SECURE,
      body: z.object({
        expenseDate: zIsoDate,
        category: z.string().trim().min(1).meta({ examples: ["6000"] }),
        payee: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().min(1).max(500),
        paymentMethod: zPaymentMethod,
        amount: zMoney,
        reference: z.string().trim().min(1).max(200).optional(),
      }),
      response: { 201: zExpense, ...errorResponses(400, 401, 403, 409, 429) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        const body = request.body;
        const expense = await recordExpense(request.tenantDb, {
          expenseDate: businessDate(body.expenseDate),
          category: body.category,
          payee: body.payee ?? null,
          description: body.description,
          paymentMethod: body.paymentMethod,
          amountCents: parseMoneyToCents(body.amount),
          reference: body.reference ?? null,
          createdBy: auth.userId,
        });
        return reply.code(201).send(expense);
      } catch (error) {
        return sendExpenseError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/",
    preHandler: [...base, readers],
    schema: {
      tags: ["Expenses"],
      summary: "List expenses",
      description: "Newest first. Voided expenses are left out unless includeVoided=true.",
      security: SECURE,
      querystring: z.object({
        from: zIsoDate.optional(),
        to: zIsoDate.optional(),
        category: z.string().min(1).optional(),
        includeVoided: z.enum(["true", "false"]).optional(),
      }),
      response: { 200: z.object({ data: z.array(zExpense) }), ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      try {
        const q = request.query;
        const data = await listExpenses(request.tenantDb, {
          from: q.from === undefined ? null : businessDate(q.from),
          to: q.to === undefined ? null : businessDate(q.to),
          category: q.category ?? null,
          includeVoided: q.includeVoided === "true",
        });
        return reply.code(200).send({ data });
      } catch (error) {
        return sendExpenseError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/:id",
    preHandler: [...base, readers],
    schema: {
      tags: ["Expenses"],
      summary: "Get an expense",
      security: SECURE,
      params: z.object({ id: z.string().min(1) }),
      response: { 200: zExpense, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await getExpense(request.tenantDb, request.params.id));
      } catch (error) {
        return sendExpenseError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/void",
    preHandler: [...base, writers],
    schema: {
      tags: ["Expenses"],
      summary: "Void an expense",
      description: "Posts a REVERSING journal entry (the original stays, immutable) and marks the expense voided. A voided expense cannot be voided again (409).",
      security: SECURE,
      params: z.object({ id: z.string().min(1) }),
      body: z.object({ reason: z.string().trim().min(1).max(500) }),
      response: { 200: zExpense, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await voidExpense(request.tenantDb, request.params.id, request.body.reason, auth.userId));
      } catch (error) {
        return sendExpenseError(reply, error);
      }
    },
  });
}
