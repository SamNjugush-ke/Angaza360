// ===========================================================================
// Reporting routes (Module 13) — financial statements, VAT return, control
// reconciliation.
//
// READ-ONLY. Every handler resolves the tenant from the SESSION (there is no tenant or
// schema parameter anywhere in these routes) and delegates to src/services/reports.ts,
// which writes nothing. Dates are YYYY-MM-DD business dates; every range is by
// entryDate. Money is cents as strings.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { tenantSchemaFor } from "../db/tenant";
import { businessToday } from "../lib/business-time";
import {
  buildBalanceSheet,
  buildCashFlow,
  buildControlReconciliation,
  buildIncomeStatement,
  buildTrialBalance,
  buildVatReturn,
  resolvePeriod,
  ReportValidationError,
  type PeriodRequest,
} from "../services/reports";
import {
  zBalanceSheet,
  zCashFlowStatement,
  zControlReconciliation,
  zIncomeStatement,
  zTrialBalanceReport,
  zVatReturn,
} from "../schemas/models";
import { badRequest, errorResponses, isoDateToUtc, SECURE, zIsoDate } from "../schemas/common";
import { RATE_LIMITS } from "../plugins/security";

const zComparative = z.enum(["true", "false"]).optional().meta({
  description: "Include the comparative column (default true).",
});

const zPeriodQuery = z.object({
  from: zIsoDate.optional().meta({ description: "Custom period start (inclusive), with `to`." }),
  to: zIsoDate.optional().meta({ description: "Custom period end (inclusive), with `from`." }),
  year: z.coerce.number().int().min(2000).max(2200).optional().meta({
    description: "A calendar year — the financial year in this build — or, with `month`, that month.",
  }),
  month: z.coerce.number().int().min(1).max(12).optional(),
  comparative: zComparative,
});

const zAsOfQuery = z.object({
  asOf: zIsoDate.optional().meta({ description: "Business date the balances are as at (default: today in Africa/Nairobi)." }),
  comparative: zComparative,
});

const zVatQuery = z.object({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

function toDate(value: string, field: string): Date {
  const parsed = isoDateToUtc(value);
  if (parsed === null) {
    throw new ReportValidationError(`${field} must be YYYY-MM-DD.`);
  }
  return parsed;
}

function periodRequest(q: { from?: string; to?: string; year?: number; month?: number }): PeriodRequest {
  return {
    ...(q.from !== undefined ? { from: toDate(q.from, "from") } : {}),
    ...(q.to !== undefined ? { to: toDate(q.to, "to") } : {}),
    ...(q.year !== undefined ? { year: q.year } : {}),
    ...(q.month !== undefined ? { month: q.month } : {}),
  };
}

function sendReportError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ReportValidationError) {
    return reply.code(400).send(badRequest(error.message));
  }
  // A ReportIntegrityError (a statement failed its own identity) or a
  // ReportClassificationError (an account no statement would show) is a DEFECT, not a
  // bad request: it is rethrown to the global handler and surfaces as a 500, loudly.
  throw error;
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];
  // The books are read by the people who run them and the people who check them.
  // CASHIER is absent: financial statements are not till information.
  const readRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "VIEWER_AUDITOR");
  // Every statement is generated on demand from the whole ledger, so each route opts
  // into the SENSITIVE rate-limit tier (Task T-A2): per client IP, per route.

  const source = (db: Parameters<typeof tenantSchemaFor>[0]) => ({ reader: db, schema: tenantSchemaFor(db) });

  api.route({
    method: "GET",
    url: "/income-statement",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Reports"],
      summary: "Income statement (profit and loss)",
      description:
        "Revenue (net of 4900 returns) − cost of sales = gross profit; − operating expenses = net profit. Movements by **entryDate** over the period: `from`+`to`, `year`+`month`, `year` (the calendar/financial year), or nothing for the current month to date. The comparative is the immediately preceding period of equal length (month → prior month, year → prior year, custom span → the same number of days ending the day before `from`).",
      security: SECURE,
      querystring: zPeriodQuery,
      response: { 200: zIncomeStatement, ...errorResponses(400, 401, 403, 429) },
    },
    handler: async (request, reply) => {
      try {
        const period = resolvePeriod(periodRequest(request.query));
        const report = await buildIncomeStatement(source(request.tenantDb), period, request.query.comparative !== "false");
        return reply.code(200).send(report);
      } catch (error) {
        return sendReportError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/balance-sheet",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Reports"],
      summary: "Balance sheet as at a business date",
      description:
        "Assets (current, non-current) = liabilities (current, long-term) + equity, **asserted to the cent** — the report fails rather than returns an unbalanced sheet. There are no closing entries, so equity carries the ACCUMULATED NET INCOME, split into prior financial years and current-year earnings. Comparative: the end of the month before `asOf`'s month.",
      security: SECURE,
      querystring: zAsOfQuery,
      response: { 200: zBalanceSheet, ...errorResponses(400, 401, 403, 429) },
    },
    handler: async (request, reply) => {
      try {
        const asOf = request.query.asOf === undefined ? businessToday() : toDate(request.query.asOf, "asOf");
        const report = await buildBalanceSheet(source(request.tenantDb), asOf, request.query.comparative !== "false");
        return reply.code(200).send(report);
      } catch (error) {
        return sendReportError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/cash-flow",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Reports"],
      summary: "Cash flow statement (indirect method)",
      description:
        "Operating (net profit + depreciation add-back + working-capital changes), investing (gross fixed assets) and financing (loans, capital, drawings, direct retained-earnings postings). **Net change in cash is asserted equal to closing − opening cash & equivalents {1000, 1010, 1015, 1020}**; the report fails rather than returns if it does not tie. Same period rules as the income statement.",
      security: SECURE,
      querystring: zPeriodQuery,
      response: { 200: zCashFlowStatement, ...errorResponses(400, 401, 403, 429) },
    },
    handler: async (request, reply) => {
      try {
        const period = resolvePeriod(periodRequest(request.query));
        const report = await buildCashFlow(source(request.tenantDb), period, request.query.comparative !== "false");
        return reply.code(200).send(report);
      } catch (error) {
        return sendReportError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/trial-balance",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Reports"],
      summary: "Trial balance as at a business date, with comparative",
      description: "Every account with its balance on the side it falls. Σ debits == Σ credits is asserted. Comparative: the end of the month before `asOf`'s month.",
      security: SECURE,
      querystring: zAsOfQuery,
      response: { 200: zTrialBalanceReport, ...errorResponses(400, 401, 403, 429) },
    },
    handler: async (request, reply) => {
      try {
        const asOf = request.query.asOf === undefined ? businessToday() : toDate(request.query.asOf, "asOf");
        const report = await buildTrialBalance(source(request.tenantDb), asOf, request.query.comparative !== "false");
        return reply.code(200).send(report);
      } catch (error) {
        return sendReportError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/vat-return",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Reports"],
      summary: "VAT return, or the TOT position for a non-registered tenant",
      description:
        "Net period movements by entryDate: output VAT (2100) − input VAT (1400) = net VAT payable/refundable, with the taxable sales and purchases behind them. For a Turnover Tax tenant the presentation is the TOT position (2110), and any VAT the ledger carries anyway is listed as a named ANOMALY — never hidden. No module accrues TOT in this build; the report says so.",
      security: SECURE,
      querystring: zVatQuery,
      response: { 200: zVatReturn, ...errorResponses(400, 401, 403, 429) },
    },
    handler: async (request, reply) => {
      try {
        const period = resolvePeriod(periodRequest(request.query));
        const report = await buildVatReturn(source(request.tenantDb), period);
        return reply.code(200).send(report);
      } catch (error) {
        return sendReportError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/control-reconciliation",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Reports"],
      summary: "Control-account reconciliation (current position)",
      description:
        "Ties each subledger to its GL control account: inventory (Σ stockValue = 1200), AR (open credit sales + the M-Pesa-failure residual = 1100), AP (unpaid bills + the ad-hoc-receipt residual = 2000), GRNI (received not billed = 2050). Each known residual is a NAMED line and `unexplained` must be 0. **Current position only**: the subledgers are current-state projections, so there is deliberately no `asOf` — a back-dated GL compared with a current subledger would manufacture a difference.",
      security: SECURE,
      response: { 200: zControlReconciliation, ...errorResponses(401, 403, 429) },
    },
    handler: async (request, reply) => {
      const db = request.tenantDb;
      const report = await buildControlReconciliation(db, tenantSchemaFor(db));
      return reply.code(200).send(report);
    },
  });
}
