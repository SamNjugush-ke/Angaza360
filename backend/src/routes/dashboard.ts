// ===========================================================================
// Dashboard + readiness routes (Task T-A10), mounted at /v1/dashboard.
//
// READ-ONLY, tenant-scoped from the session (no tenant parameter anywhere). Every figure
// is derived from the Module 13 builders — see src/services/dashboard.ts. The period
// follows the reports' rules: `from`+`to`, `year`+`month`, `year`, or nothing (the
// current month to date).
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { badRequest, errorResponses, isoDateToUtc, SECURE, unauthorized, zCentsString, zIsoDate, zTimestamp } from "../schemas/common";
import { buildDashboard, buildDashboardTrend, buildReadiness, TREND_MAX_MONTHS, TREND_MIN_MONTHS } from "../services/dashboard";
import { ReportValidationError, resolvePeriod, type PeriodRequest } from "../services/reports";

const zAccountFigure = z.object({ code: z.string(), name: z.string(), amount: zCentsString });

const zDashboard = z.object({
  period: z.object({ from: zTimestamp, to: zTimestamp }),
  revenue: zCentsString,
  costOfSales: zCentsString,
  grossProfit: zCentsString,
  operatingExpenses: zCentsString,
  netProfit: zCentsString,
  cashPosition: z.object({ total: zCentsString, accounts: z.array(zAccountFigure) }),
  receivables: zCentsString,
  payables: zCentsString,
  topExpenseCategories: z.array(zAccountFigure),
  lowStockCount: z.number().int(),
});

const zTrendBucket = z.object({
  month: z.string().describe("The business month, YYYY-MM (Africa/Nairobi)."),
  from: zIsoDate,
  to: zIsoDate,
  partial: z.boolean().describe("True for the current month, which is month-to-date."),
  revenue: zCentsString,
  costOfSales: zCentsString,
  grossProfit: zCentsString,
  operatingExpenses: zCentsString,
  netProfit: zCentsString,
});

const zReadiness = z.object({
  readyToTrade: z.boolean(),
  checks: z.array(
    z.object({
      key: z.enum(["ACTIVE_PRODUCT", "STOCK_OR_SERVICE", "TAX_REGIME_SET", "FIRST_SALE", "KRA_PIN", "STAFF_BEYOND_OWNER"]),
      label: z.string(),
      required: z.boolean(),
      pass: z.boolean(),
      detail: z.string(),
    }),
  ),
});

function toDate(value: string, field: string): Date {
  const date = isoDateToUtc(value);
  if (date === null) {
    throw new ReportValidationError(`${field} must be YYYY-MM-DD.`);
  }
  return date;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];

  api.route({
    method: "GET",
    url: "/",
    preHandler: [...base, app.requireRole("MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "VIEWER_AUDITOR")],
    schema: {
      tags: ["Dashboard"],
      summary: "The home-screen figures for a period",
      description:
        "Revenue, cost of sales, gross and net profit and operating expenses from the income statement; cash position (1000, 1010, 1020), receivables (1100) and payables (2000) from the balance sheet as at the period's last day; the top expense categories; and the low-stock count. Every figure is derived from the Module 13 builders — the dashboard does no accounting of its own.",
      security: SECURE,
      querystring: z.object({
        from: zIsoDate.optional(),
        to: zIsoDate.optional(),
        year: z.coerce.number().int().min(2000).max(2200).optional(),
        month: z.coerce.number().int().min(1).max(12).optional(),
      }),
      response: { 200: zDashboard, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      try {
        const q = request.query;
        const periodRequest: PeriodRequest = {
          ...(q.from !== undefined ? { from: toDate(q.from, "from") } : {}),
          ...(q.to !== undefined ? { to: toDate(q.to, "to") } : {}),
          ...(q.year !== undefined ? { year: q.year } : {}),
          ...(q.month !== undefined ? { month: q.month } : {}),
        };
        return reply.code(200).send(await buildDashboard(request.tenantDb, resolvePeriod(periodRequest)));
      } catch (error) {
        if (error instanceof ReportValidationError) {
          return reply.code(400).send(badRequest(error.message));
        }
        throw error;
      }
    },
  });

  api.route({
    method: "GET",
    url: "/trend",
    preHandler: [...base, app.requireRole("MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "VIEWER_AUDITOR")],
    schema: {
      tags: ["Dashboard"],
      summary: "Monthly trend: the income statement for each of the last N months",
      description:
        "One bucket per calendar month (Africa/Nairobi business months), oldest first, ending with the current month — which is month-to-date and flagged partial, exactly as the dashboard shows it. Each bucket's revenue, cost of sales, gross profit, operating expenses and net profit are the Module 13 income statement for that month (net movements by entry date, so a void reduces the month it is posted in). Months with no activity are zeros, never omitted. Money is a string of cents.",
      security: SECURE,
      querystring: z.object({
        months: z.coerce.number().int().min(TREND_MIN_MONTHS).max(TREND_MAX_MONTHS).default(6),
      }),
      response: { 200: z.array(zTrendBucket), ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => reply.code(200).send(await buildDashboardTrend(request.tenantDb, request.query.months)),
  });

  api.route({
    method: "GET",
    url: "/readiness",
    preHandler: [...base, app.requireRole("MSME_OWNER", "MSME_MANAGER")],
    schema: {
      tags: ["Dashboard"],
      summary: "Merchant readiness: is this business ready to trade?",
      description:
        "Concrete checks over the business's own state, each pass/fail and required or recommended: an active product; something to sell (stocked goods or an active service); a tax regime on the business profile; and, recommended, a first sale, a KRA PIN and staff beyond the owner. readyToTrade is every REQUIRED check passing.",
      security: SECURE,
      response: { 200: zReadiness, ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null || auth.tenantId === null) return reply.code(401).send(unauthorized("Authentication required."));
      return reply.code(200).send(await buildReadiness(request.tenantDb, auth.tenantId));
    },
  });
}
