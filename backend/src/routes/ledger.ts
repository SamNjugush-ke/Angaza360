import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { parseMoneyToCents } from "../lib/money";
import {
  postJournalEntry,
  reverseJournalEntry,
  getTrialBalance,
  getAccountLedger,
  closePeriod,
  reopenPeriod,
  LedgerValidationError,
  LedgerImbalanceError,
  PeriodClosedError,
  type JournalLineInput,
} from "../services/ledger";
import { PeriodCloseBlockedError } from "../services/offline/custody";
import {
  zAccountClass,
  zAccountingPeriod,
  zAccountingPeriodRow,
  zAccountLedgerRow,
  zJournalEntryDetail,
  zJournalEntryListRow,
  zJournalEntryResult,
  zJournalSource,
  zNormalBalance,
  zTrialBalanceRow,
} from "../schemas/models";
import {
  badRequest,
  conflict,
  errorResponses,
  errorBody,
  isoDateToUtc,
  notFound,
  SECURE,
  businessTodayDate,
  zAccountCodeParam,
  zCentsString,
  zIdParam,
  zIsoDate,
  zMoneyNonNegative,
  zPaginationResult,
  zPaginationWithDefault,
} from "../schemas/common";

// All ledger writes go through src/services/ledger.ts. These routes only
// authorise requests and delegate; reads query request.tenantDb directly.
// Request validation is entirely the Zod schema's job.

const zJournalLineBody = z.object({
  accountCode: z.string().trim().min(1, "accountCode is required."),
  debit: zMoneyNonNegative.optional(),
  credit: zMoneyNonNegative.optional(),
  memo: z.string().min(1).optional(),
});

const zPostEntryBody = z.object({
  entryDate: zIsoDate,
  description: z.string().trim().min(1, "description is required."),
  reference: z.string().optional(),
  source: zJournalSource,
  sourceId: z.string().optional(),
  lines: z.array(zJournalLineBody).meta({
    description:
      "Debits must equal credits. The balance is enforced by a deferred database constraint, not only here.",
  }),
});

const zPeriodParams = z.object({
  year: z.coerce.number().int().min(2000).max(9999),
  month: z.coerce.number().int().min(1).max(12),
});

// A journal entry's balance, and the account-exists check, are CROSS-FIELD and
// database-backed rules that a per-field schema cannot express. They stay in
// the ledger service (and ultimately in the DB constraint) and surface here as
// LedgerImbalanceError / LedgerValidationError -> 400.
function sendLedgerError(reply: FastifyReply, error: unknown): FastifyReply {
  // A period that cannot close because a device still holds live custody of
  // stock (Task OFF.1). Conflict, not bad input: the request is well formed and
  // the answer may change once the device syncs or hands in its lease.
  if (error instanceof PeriodCloseBlockedError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof PeriodClosedError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof LedgerValidationError || error instanceof LedgerImbalanceError) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

function buildLines(
  raw: z.infer<typeof zPostEntryBody>["lines"],
): JournalLineInput[] {
  return raw.map((entry) => {
    const line: JournalLineInput = { accountCode: entry.accountCode };
    if (entry.debit !== undefined) {
      line.debit = parseMoneyToCents(entry.debit);
    }
    if (entry.credit !== undefined) {
      line.credit = parseMoneyToCents(entry.credit);
    }
    if (entry.memo !== undefined) {
      line.memo = entry.memo;
    }
    return line;
  });
}

export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];
  const readRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "ACCOUNTANT",
    "VIEWER_AUDITOR",
  );
  const postRoles = app.requireRole("MSME_OWNER", "ACCOUNTANT");

  api.route({
    method: "POST",
    url: "/entries",
    preHandler: [...base, postRoles],
    schema: {
      tags: ["Ledger"],
      summary: "Post a balanced journal entry",
      description:
        "Debits must equal credits (enforced by a deferred DB constraint). Amounts are decimal strings. createdBy is taken from the session, never the body. Posting into a CLOSED period returns 409.",
      security: SECURE,
      body: zPostEntryBody,
      response: {
        201: zJournalEntryResult,
        ...errorResponses(400, 401, 403, 409),
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      const entryDate = isoDateToUtc(body.entryDate);
      if (entryDate === null) {
        return reply.code(400).send(badRequest("entryDate is required as YYYY-MM-DD."));
      }

      try {
        const result = await postJournalEntry(request.tenantDb, {
          entryDate,
          description: body.description,
          ...(body.reference !== undefined ? { reference: body.reference } : {}),
          source: body.source,
          ...(body.sourceId !== undefined ? { sourceId: body.sourceId } : {}),
          // createdBy comes ONLY from the verified session, never the body.
          createdBy: auth.userId,
          lines: buildLines(body.lines),
        });
        return reply.code(201).send(result);
      } catch (error) {
        return sendLedgerError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/entries",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Ledger"],
      summary: "List journal entries",
      description: "Newest first. Optionally filtered by date range, source module, or account code.",
      security: SECURE,
      querystring: zPaginationWithDefault(25).extend({
        from: zIsoDate.optional(),
        to: zIsoDate.optional(),
        source: zJournalSource.optional(),
        accountCode: z.string().optional(),
      }),
      response: {
        200: z.object({
          data: z.array(zJournalEntryListRow),
          pagination: zPaginationResult,
        }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { from, to, source, accountCode, take, skip } = request.query;

      const dateFilter: { gte?: Date; lte?: Date } = {};
      if (from !== undefined) {
        const parsed = isoDateToUtc(from);
        if (parsed === null) {
          return reply.code(400).send(badRequest("from must be YYYY-MM-DD."));
        }
        dateFilter.gte = parsed;
      }
      if (to !== undefined) {
        const parsed = isoDateToUtc(to);
        if (parsed === null) {
          return reply.code(400).send(badRequest("to must be YYYY-MM-DD."));
        }
        dateFilter.lte = parsed;
      }

      const where = {
        ...(dateFilter.gte !== undefined || dateFilter.lte !== undefined
          ? { entryDate: dateFilter }
          : {}),
        ...(source !== undefined ? { source } : {}),
        ...(accountCode !== undefined && accountCode !== ""
          ? { lines: { some: { account: { code: accountCode } } } }
          : {}),
      };

      const [data, total] = await Promise.all([
        request.tenantDb.journalEntry.findMany({
          where,
          include: { lines: { include: { account: { select: { code: true, name: true } } } } },
          orderBy: [{ entryDate: "desc" }, { entryNumber: "desc" }],
          take,
          skip,
        }),
        request.tenantDb.journalEntry.count({ where }),
      ]);

      return reply.code(200).send({ data, pagination: { take, skip, total } });
    },
  });

  api.route({
    method: "GET",
    url: "/entries/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Ledger"],
      summary: "Get one journal entry with its lines",
      security: SECURE,
      params: zIdParam,
      response: { 200: zJournalEntryDetail, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const entry = await request.tenantDb.journalEntry.findUnique({
        where: { id },
        include: {
          lines: {
            include: { account: { select: { code: true, name: true, accountClass: true } } },
            orderBy: { lineNumber: "asc" },
          },
        },
      });
      if (entry === null) {
        return reply.code(404).send(notFound(`No journal entry with id "${id}".`));
      }
      return reply.code(200).send(entry);
    },
  });

  api.route({
    method: "POST",
    url: "/entries/:id/reverse",
    preHandler: [...base, postRoles],
    schema: {
      tags: ["Ledger"],
      summary: "Reverse a posted entry",
      description:
        "A posted entry is immutable: corrections are made by posting a reversing entry, never by editing. Returns the new reversing entry.",
      security: SECURE,
      params: zIdParam,
      body: z.object({ reason: z.string().trim().min(1, "reason is required.") }),
      response: {
        201: zJournalEntryResult,
        ...errorResponses(400, 401, 403, 409),
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const result = await reverseJournalEntry(
          request.tenantDb,
          request.params.id,
          request.body.reason,
          auth.userId,
        );
        return reply.code(201).send(result);
      } catch (error) {
        return sendLedgerError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/trial-balance",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Ledger"],
      summary: "Trial balance as at a date",
      description:
        "Per-account debit/credit totals and the balance check. totals.balanced is true when total debits equal total credits.",
      security: SECURE,
      querystring: z.object({ asOf: zIsoDate.optional() }),
      response: {
        200: z.object({
          asOf: z.string(),
          rows: z.array(zTrialBalanceRow),
          totals: z.object({
            totalDebit: zCentsString,
            totalCredit: zCentsString,
            balanced: z.boolean(),
          }),
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

      const rows = await getTrialBalance(request.tenantDb, asOf);
      let totalDebit = 0n;
      let totalCredit = 0n;
      for (const row of rows) {
        totalDebit += row.totalDebit;
        totalCredit += row.totalCredit;
      }

      return reply.code(200).send({
        asOf: asOf.toISOString().slice(0, 10),
        rows,
        totals: { totalDebit, totalCredit, balanced: totalDebit === totalCredit },
      });
    },
  });

  api.route({
    method: "GET",
    url: "/accounts/:code/ledger",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Ledger"],
      summary: "Account ledger with running balance",
      security: SECURE,
      params: zAccountCodeParam,
      querystring: zPaginationWithDefault(50).extend({
        from: zIsoDate.optional(),
        to: zIsoDate.optional(),
      }),
      response: {
        200: z.object({
          account: z.object({
            code: z.string(),
            name: z.string(),
            accountClass: zAccountClass,
            normalBalance: zNormalBalance,
          }),
          openingBalance: zCentsString,
          closingBalance: zCentsString,
          rows: z.array(zAccountLedgerRow),
          pagination: zPaginationResult,
        }),
        ...errorResponses(400, 401, 403, 404),
      },
    },
    handler: async (request, reply) => {
      const { code } = request.params;
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

      try {
        const result = await getAccountLedger(
          request.tenantDb,
          code,
          fromDate,
          toDate,
          take,
          skip,
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof LedgerValidationError) {
          return reply.code(404).send(notFound(error.message));
        }
        throw error;
      }
    },
  });

  api.route({
    method: "GET",
    url: "/periods",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Ledger"],
      summary: "List accounting periods",
      security: SECURE,
      response: {
        200: z.object({ data: z.array(zAccountingPeriodRow) }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (request, reply) => {
      const periods = await request.tenantDb.accountingPeriod.findMany({
        orderBy: [{ year: "desc" }, { month: "desc" }],
      });
      return reply.code(200).send({ data: periods });
    },
  });

  api.route({
    method: "POST",
    url: "/periods/:year/:month/close",
    preHandler: [...base, postRoles],
    schema: {
      tags: ["Ledger"],
      summary: "Close an accounting period",
      description:
        "A closed period rejects further postings at the database level.\n\n" +
        "**409 — business-time integrity guard (Task OFF.1).** The close is REFUSED while any ACTIVE offline device still holds a LIVE lease that could carry sales dated inside the period and has not synced past its end. Closing then would assert a complete month over sales the server knows may exist. Have each device sync, or end its lease (`POST /v1/offline/devices/:id/lease/end`), then close.\n\n" +
        "An EXPIRED lease does NOT block: expiry freezes the device's stock to PENDING_RECONCILIATION and raises it for a decision, so what it may be carrying is known and flagged rather than unknown — and anything that arrives later posts into the current open period with its true business date recorded on the sale.",
      security: SECURE,
      params: zPeriodParams,
      response: { 200: zAccountingPeriod, ...errorResponses(400, 401, 403, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const { year, month } = request.params;
      try {
        const period = await closePeriod(request.tenantDb, year, month, auth.userId);
        request.log.info({ userId: auth.userId, year, month }, "accounting period closed");
        return reply.code(200).send(period);
      } catch (error) {
        return sendLedgerError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/periods/:year/:month/reopen",
    preHandler: [...base, app.requireRole("MSME_OWNER")],
    schema: {
      tags: ["Ledger"],
      summary: "Reopen a closed period (owner only)",
      description: "Audit-relevant privileged action; logged at warn level.",
      security: SECURE,
      params: zPeriodParams,
      response: { 200: zAccountingPeriod, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const { year, month } = request.params;
      const period = await reopenPeriod(request.tenantDb, year, month, auth.userId);
      request.log.warn(
        { userId: auth.userId, year, month },
        "accounting period REOPENED by owner",
      );
      return reply.code(200).send(period);
    },
  });
}
