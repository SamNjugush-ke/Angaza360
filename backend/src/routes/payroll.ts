// ===========================================================================
// Payroll routes — employees, the statutory ruleset, runs and payslips
// (Module 8, Task 8.1), plus settlement and filing output (Task 8.2).
//
// These routes authorise and delegate. Payroll state goes through
// src/services/payroll.ts, the sole writer of the payroll tables and the only poster
// of the ACCRUAL; every figure is computed by src/lib/payroll-math.ts, which is pure.
// Settlement goes through src/services/payroll-settlement.ts, the sole writer of the
// settlement tables and the only poster of SETTLEMENT GL (liability -> cash, nothing
// else). Filing output comes from src/services/payroll-filing.ts, which writes nothing
// and recomputes nothing. No route here writes a stock table, and nothing in this
// module posts to 1200 or to any revenue account.
//
// Money is cents as STRINGS in and out; rates are decimal strings. A JSON number in
// a money field is rejected by the schema, because a number can lose precision
// before it ever reaches us — and a payroll figure that drifts by a cent is a figure
// an employee will dispute.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { platformDb } from "../db/platform";
import { parseMoneyToCents } from "../lib/money";
import {
  approvePayrollRun,
  cancelPayrollRun,
  createEmployee,
  createPayrollRun,
  getEmployee,
  getPayrollRun,
  getPayslip,
  listEmployees,
  listPayrollRuns,
  listPayslipsForRun,
  listStatutorySchedules,
  postPayrollRun,
  recomputePayrollRun,
  setEmployeeStatus,
  updateEmployee,
  PayrollInputError,
  PayrollRulesetError,
  PayrollStateError,
  PayrollValidationError,
  type AllowanceInput,
} from "../services/payroll";
import {
  getNetPayPaymentForRun,
  getStatutoryRemittance,
  listStatutoryRemittances,
  recordStatutoryRemittance,
  settleNetPay,
  PayrollNotFoundError,
} from "../services/payroll-settlement";
import {
  buildMusterRoll,
  buildPayslipDocument,
  buildStatutorySummary,
} from "../services/payroll-filing";
import { LedgerValidationError, PeriodClosedError } from "../services/ledger";
import {
  zEmployee,
  zEmployeePaymentMethod,
  zEmployeeStatus,
  zEmploymentType,
  zMusterRoll,
  zNetPayPayment,
  zPayrollRun,
  zPayrollRunDetail,
  zPayrollRunStatus,
  zPayrollSettlementMethod,
  zPayslip,
  zPayslipDocument,
  zStatutoryRemittance,
  zStatutorySchedule,
  zStatutorySummary,
  zStatutoryType,
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

const zAllowanceBody = z.object({
  name: z.string().trim().min(1, "An allowance needs a name."),
  amount: zMoneyNonNegative.meta({ description: "The fixed MONTHLY amount, as a decimal money string." }),
  taxable: z.boolean().optional().meta({
    description:
      "Defaults to true. A non-taxable allowance is still part of GROSS — and therefore of NSSF, SHIF and the housing levy, which are not income taxes — but is excluded from the pay PAYE is computed on.",
  }),
});

const zCreateEmployeeBody = z.object({
  firstName: z.string().trim().min(1, "firstName is required."),
  lastName: z.string().trim().min(1, "lastName is required."),
  nationalId: z.string().trim().min(1).optional(),
  kraPin: z.string().trim().min(1).optional().meta({
    description:
      "Nullable because an MSME often hires before the number is in hand, and refusing the record would push the employee off the books entirely. Filing (Task 8.2) is where its absence becomes an error.",
  }),
  nssfNumber: z.string().trim().min(1).optional(),
  shifNumber: z.string().trim().min(1).optional(),
  employmentType: zEmploymentType.optional(),
  hireDate: zIsoDate,
  basicSalary: zMoneyNonNegative.meta({
    description:
      "Monthly basic pay as a decimal money string. Zero is legal (an unpaid director on the books); negative is refused by the schema and by a database CHECK.",
  }),
  paymentMethod: zEmployeePaymentMethod.optional(),
  bankName: z.string().trim().min(1).optional(),
  bankAccount: z.string().trim().min(1).optional(),
  allowances: z.array(zAllowanceBody).optional().meta({
    description: "Fixed recurring monthly allowances only (house, transport). Overtime, bonuses and benefits in kind are deferred.",
  }),
});

const zUpdateEmployeeBody = z.object({
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  nationalId: z.string().nullable().optional(),
  kraPin: z.string().nullable().optional(),
  nssfNumber: z.string().nullable().optional(),
  shifNumber: z.string().nullable().optional(),
  employmentType: zEmploymentType.optional(),
  basicSalary: zMoneyNonNegative.optional(),
  paymentMethod: zEmployeePaymentMethod.optional(),
  bankName: z.string().nullable().optional(),
  bankAccount: z.string().nullable().optional(),
  allowances: z.array(zAllowanceBody).optional().meta({
    description:
      "Supplied: the allowance set is REPLACED wholesale. Omitted: allowances are untouched. Replacement rather than merge is deliberate — a partial merge needs a per-line identity the client does not have, and guessing one silently drops a change.",
  }),
});

const zStatusBody = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "TERMINATED"]).meta({
    description:
      "SUSPENDED and TERMINATED both drop the employee out of NEW runs. Neither deletes anything and neither touches a payslip already computed — an employee with payroll history can never be deleted, because the history is what a P9 is built from.",
  }),
  terminationDate: zIsoDate.optional().meta({
    description: "REQUIRED when terminating, and refused otherwise: an employee who has left without a leaving date cannot be filed for.",
  }),
});

const zCreateRunBody = z.object({
  periodYear: z.number().int().min(2000).max(2200),
  periodMonth: z.number().int().min(1).max(12),
  payDate: zIsoDate.meta({ description: "When the net pay is intended to reach employees. **The accrual entry is dated to it.**" }),
  notes: z.string().min(1).optional(),
});

const zSettleNetBody = z.object({
  paymentDate: zIsoDate.meta({
    description: "The date the money left. **The settlement entry is dated to it**, so 409 if that period is closed.",
  }),
  method: zPayrollSettlementMethod.meta({
    description:
      "The ONE account the whole run is paid from: CASH -> 1000, BANK -> 1020, MPESA -> 1010. MPESA records a payment made over M-Pesa; it disburses nothing.",
  }),
  reference: z.string().trim().min(1).optional().meta({ description: "Bank batch or transfer reference." }),
  notes: z.string().trim().min(1).optional(),
});

const zRemittanceBody = z.object({
  statutoryType: zStatutoryType.meta({
    description: "PAYE -> 2200 (KRA), NSSF -> 2210 (NSSF), SHIF -> 2220 (SHA), HOUSING_LEVY -> 2230 (KRA).",
  }),
  amount: zMoneyNonNegative.meta({
    description:
      "Decimal money string; must be positive. **It may not exceed what is owed**: the head's current GL credit balance, and — when payrollRunId is given — what that run's accrual credited to the head less what has already been remitted against it.",
  }),
  remittanceDate: zIsoDate.meta({ description: "The date the money left. The remittance entry is dated to it." }),
  method: zPayrollSettlementMethod,
  reference: z.string().trim().min(1).optional().meta({
    description: "The authority's own payment reference (KRA PRN, NSSF or SHA receipt).",
  }),
  notes: z.string().trim().min(1).optional(),
  payrollRunId: z.string().min(1).optional().meta({
    description: "Attribute the remittance to one POSTED or PAID run. Omit for arrears or a consolidation across months.",
  }),
});

const zRemittanceQuery = z.object({
  statutoryType: zStatutoryType.optional(),
  payrollRunId: z.string().min(1).optional(),
  from: zIsoDate.optional().meta({ description: "Inclusive lower bound on remittanceDate." }),
  to: zIsoDate.optional().meta({ description: "Inclusive upper bound on remittanceDate." }),
});

const zCancelRunBody = z.object({
  reason: z.string().trim().min(1, "reason is required.").meta({
    description: "Recorded on the run's notes, so a cancelled payroll says why.",
  }),
});

// State-dependent rules — is this run still a DRAFT, does a schedule cover the
// period, is the period open — depend on rows in the database rather than on the
// shape of the request, so they stay in the service and surface here.
function sendPayrollError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PayrollNotFoundError) {
    return reply.code(404).send(notFound(error.message));
  }
  if (error instanceof PayrollStateError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof PeriodClosedError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (
    error instanceof PayrollValidationError ||
    error instanceof PayrollInputError ||
    error instanceof PayrollRulesetError ||
    error instanceof LedgerValidationError
  ) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

/** A validated YYYY-MM-DD is already known to parse; this keeps the type honest. */
function requireDate(value: string, field: string): Date {
  const parsed = isoDateToUtc(value);
  if (parsed === null) {
    throw new PayrollValidationError(`${field} must be YYYY-MM-DD.`);
  }
  return parsed;
}

/**
 * The employer's display name for a filing document — the same platform registry name
 * the sale receipt prints. Display identity only: no figure is read across schemas, and
 * the employer's KRA PIN comes from the tenant's own business profile.
 */
async function employerName(tenantId: string | null): Promise<string> {
  if (tenantId === null) {
    return "";
  }
  const tenant = await platformDb.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true },
  });
  return tenant?.name ?? "";
}

function buildAllowances(
  raw: ReadonlyArray<z.infer<typeof zAllowanceBody>>,
): AllowanceInput[] {
  return raw.map((allowance) => ({
    name: allowance.name,
    amount: parseMoneyToCents(allowance.amount),
    ...(allowance.taxable !== undefined ? { taxable: allowance.taxable } : {}),
  }));
}

export async function payrollRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];

  // THE RBAC SPLIT, AND WHY HR_OFFICER IS HERE.
  //
  // The task specified MSME_OWNER / MANAGER with no CASHIER access, and CASHIER is
  // refused everywhere below. HR_OFFICER is included on the HR half, deliberately:
  // The engineering ledger records that role as existing for "employee records, leave, payroll
  // processing", so leaving it ungated would give a declared role no purpose and
  // force an owner to key in every employee. The split follows the money instead of
  // the module:
  //
  //   HR work      — the employee master, and computing a DRAFT run (posts nothing)
  //   MONEY work   — approving, posting the accrual, cancelling
  //
  // APPROVE and POST stay OWNER/MANAGER only, because posting commits the business
  // to what it owes its staff and three authorities. That is the same shape as
  // procurement (raise vs approve) and payables (enter vs pay).
  const hrRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "HR_OFFICER");
  const approvalRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER");
  const readRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "HR_OFFICER",
    "ACCOUNTANT",
    "VIEWER_AUDITOR",
  );

  // --- The statutory ruleset (READ ONLY) -----------------------------------

  api.route({
    method: "GET",
    url: "/statutory-schedules",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Read the effective-dated statutory rulesets, newest first",
      description:
        "**THERE IS NO ROUTE THAT WRITES A RATE, and that is deliberate.** A statutory figure is the law of Kenya rather than tenant configuration: every MSME on this platform must compute a given month on the SAME bands, or two businesses file different PAYE for the same salary. So the ruleset arrives by the same platform-run seed mechanism as the chart of accounts — provisioning for a new tenant, the migration runner for existing ones — and a statutory update is ONE dated operation across all of them.\n\n" +
        "Each row carries its `source` and `verifiedOn`, because the engineering ledger makes verifying the in-force figures against an authoritative source and recording the citation a standing requirement rather than a courtesy.\n\n" +
        "EXACTLY ONE schedule may cover any date — a GiST exclusion constraint over the half-open effective window guarantees it — and a payroll period with no covering schedule REFUSES the run rather than falling back to a later ruleset.",
      security: SECURE,
      response: {
        200: z.object({ data: z.array(zStatutorySchedule), count: z.number().int() }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (request, reply) => {
      const data = await listStatutorySchedules(request.tenantDb);
      return reply.code(200).send({ data, count: data.length });
    },
  });

  // --- Employees -----------------------------------------------------------

  api.route({
    method: "POST",
    url: "/employees",
    preHandler: [...base, hrRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Add an employee to the payroll",
      description:
        "Monthly salaried terms: a basic salary plus fixed recurring allowances. A payroll run SNAPSHOTS these into its payslips, so a later revision affects the NEXT run and never a payslip already computed.",
      security: SECURE,
      body: zCreateEmployeeBody,
      response: { 201: zEmployee, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const body = request.body;
      try {
        const created = await createEmployee(request.tenantDb, {
          firstName: body.firstName,
          lastName: body.lastName,
          ...(body.nationalId !== undefined ? { nationalId: body.nationalId } : {}),
          ...(body.kraPin !== undefined ? { kraPin: body.kraPin } : {}),
          ...(body.nssfNumber !== undefined ? { nssfNumber: body.nssfNumber } : {}),
          ...(body.shifNumber !== undefined ? { shifNumber: body.shifNumber } : {}),
          ...(body.employmentType !== undefined ? { employmentType: body.employmentType } : {}),
          hireDate: requireDate(body.hireDate, "hireDate"),
          basicSalary: parseMoneyToCents(body.basicSalary),
          ...(body.paymentMethod !== undefined ? { paymentMethod: body.paymentMethod } : {}),
          ...(body.bankName !== undefined ? { bankName: body.bankName } : {}),
          ...(body.bankAccount !== undefined ? { bankAccount: body.bankAccount } : {}),
          ...(body.allowances !== undefined ? { allowances: buildAllowances(body.allowances) } : {}),
        });
        return reply.code(201).send(created);
      } catch (error) {
        return sendPayrollError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/employees",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "List employees",
      description: "Employee number order. Filter by status — ACTIVE is who a new run would pay.",
      security: SECURE,
      querystring: z.object({ status: zEmployeeStatus.optional() }),
      response: {
        200: z.object({
          data: z.array(zEmployee),
          count: z.number().int(),
          totalGrossMonthly: zCentsString,
        }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { status } = request.query;
      const data = await listEmployees(
        request.tenantDb,
        status !== undefined ? { status } : {},
      );
      const totalGrossMonthly = data.reduce((sum, e) => sum + e.grossMonthly, 0n);
      return reply.code(200).send({ data, count: data.length, totalGrossMonthly });
    },
  });

  api.route({
    method: "GET",
    url: "/employees/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Get one employee with their allowances",
      security: SECURE,
      params: zIdParam,
      response: { 200: zEmployee, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const employee = await getEmployee(request.tenantDb, request.params.id);
      if (employee === null) {
        return reply.code(404).send(notFound(`No employee with id "${request.params.id}".`));
      }
      return reply.code(200).send(employee);
    },
  });

  api.route({
    method: "PATCH",
    url: "/employees/:id",
    preHandler: [...base, hrRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Update an employee's standing terms",
      description:
        "**IT CHANGES NO PAYSLIP, EVER.** A run snapshots the terms, so a salary revision affects the NEXT run; a DRAFT run only picks it up when explicitly recomputed, and a posted payslip is frozen by a database trigger regardless. That is what makes \"what was this employee paid in March\" answerable in December.",
      security: SECURE,
      params: zIdParam,
      body: zUpdateEmployeeBody,
      response: { 200: zEmployee, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const body = request.body;
      try {
        const updated = await updateEmployee(request.tenantDb, request.params.id, {
          ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
          ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
          ...(body.nationalId !== undefined ? { nationalId: body.nationalId } : {}),
          ...(body.kraPin !== undefined ? { kraPin: body.kraPin } : {}),
          ...(body.nssfNumber !== undefined ? { nssfNumber: body.nssfNumber } : {}),
          ...(body.shifNumber !== undefined ? { shifNumber: body.shifNumber } : {}),
          ...(body.employmentType !== undefined ? { employmentType: body.employmentType } : {}),
          ...(body.basicSalary !== undefined
            ? { basicSalary: parseMoneyToCents(body.basicSalary) }
            : {}),
          ...(body.paymentMethod !== undefined ? { paymentMethod: body.paymentMethod } : {}),
          ...(body.bankName !== undefined ? { bankName: body.bankName } : {}),
          ...(body.bankAccount !== undefined ? { bankAccount: body.bankAccount } : {}),
          ...(body.allowances !== undefined
            ? { allowances: buildAllowances(body.allowances) }
            : {}),
        });
        return reply.code(200).send(updated);
      } catch (error) {
        return sendPayrollError(reply, error);
      }
    },
  });

  api.route({
    method: "PATCH",
    url: "/employees/:id/status",
    preHandler: [...base, hrRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Suspend, terminate or reinstate an employee",
      description:
        "SUSPENDED and TERMINATED both drop the employee out of NEW payroll runs; neither deletes anything. An employee with payroll history can never be deleted, which is why this is a status change — the history is what a P9 is built from. A termination REQUIRES its date, enforced here and by a database CHECK.",
      security: SECURE,
      params: zIdParam,
      body: zStatusBody,
      response: { 200: zEmployee, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const body = request.body;
      try {
        const updated = await setEmployeeStatus(
          request.tenantDb,
          request.params.id,
          body.status,
          body.terminationDate !== undefined
            ? requireDate(body.terminationDate, "terminationDate")
            : undefined,
        );
        return reply.code(200).send(updated);
      } catch (error) {
        return sendPayrollError(reply, error);
      }
    },
  });

  // --- Runs ----------------------------------------------------------------

  api.route({
    method: "POST",
    url: "/runs",
    preHandler: [...base, hrRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Create a DRAFT payroll run for a period and compute its payslips",
      description:
        "**A DRAFT POSTS NOTHING TO THE LEDGER.** It resolves the statutory schedule governing the period, snapshots every ACTIVE employee's basic pay and allowances, and runs the gross-to-net engine over them. Nothing is committed to the books, which is why the payroll officer can recompute it as often as they like while chasing a missing allowance.\n\n" +
        "The period must be covered by EXACTLY ONE statutory schedule or the run is **refused**: computing February on March's bands would be invisible in the output, which is precisely what the effective-dated ruleset exists to prevent.\n\n" +
        "**409 if a non-CANCELLED run already covers the month.** Two live payrolls for one month would double the salary expense, double what every statutory head is owed, and create two net-pay obligations for the same work.",
      security: SECURE,
      body: zCreateRunBody,
      response: { 201: zPayrollRunDetail, ...errorResponses(400, 401, 403, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      try {
        const run = await createPayrollRun(request.tenantDb, {
          periodYear: body.periodYear,
          periodMonth: body.periodMonth,
          payDate: requireDate(body.payDate, "payDate"),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          createdById: auth.userId,
        });
        return reply.code(201).send(run);
      } catch (error) {
        return sendPayrollError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/runs",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "List payroll runs with their totals",
      description: "Newest run number first. Filter by status or period year.",
      security: SECURE,
      querystring: z.object({
        status: zPayrollRunStatus.optional(),
        periodYear: z.coerce.number().int().min(2000).max(2200).optional(),
      }),
      response: {
        200: z.object({ data: z.array(zPayrollRun), count: z.number().int() }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { status, periodYear } = request.query;
      const data = await listPayrollRuns(request.tenantDb, {
        ...(status !== undefined ? { status } : {}),
        ...(periodYear !== undefined ? { periodYear } : {}),
      });
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/runs/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Get one payroll run with every payslip",
      description:
        "Each payslip carries every intermediate figure — gross, taxable gross, each statutory contribution, taxable pay, PAYE before and after relief, and net — so it is defensible to the employee and to KRA without re-running the engine.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zPayrollRunDetail, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const run = await getPayrollRun(request.tenantDb, request.params.id);
      if (run === null) {
        return reply.code(404).send(notFound(`No payroll run with id "${request.params.id}".`));
      }
      return reply.code(200).send(run);
    },
  });

  api.route({
    method: "POST",
    url: "/runs/:id/recompute",
    preHandler: [...base, hrRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Recompute a DRAFT run against the current employee master",
      description:
        "Replaces every payslip. **409 once the run leaves DRAFT**, and a database trigger refuses it too: a posted run's payslips ARE its accrual entry, so recomputing them would make the seven posted legs disagree with the columns they were summed from.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zPayrollRunDetail, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      try {
        const run = await recomputePayrollRun(request.tenantDb, request.params.id);
        return reply.code(200).send(run);
      } catch (error) {
        return sendPayrollError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/runs/:id/approve",
    preHandler: [...base, approvalRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Approve a DRAFT run (owner or manager)",
      description:
        "Freezes the payslips and the schedule the run used, without posting anything. Approval is a separate step from posting because it is where a person signs off the figures, and from that moment they must stop moving.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zPayrollRunDetail, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const run = await approvePayrollRun(request.tenantDb, request.params.id, auth.userId);
        return reply.code(200).send(run);
      } catch (error) {
        return sendPayrollError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/runs/:id/post",
    preHandler: [...base, approvalRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Post the accrual for an APPROVED run (owner or manager)",
      description:
        "**This is the operation with the financial effect.** In ONE transaction it posts:\n\n" +
        "```\nDr 6020 Salaries & Wages                  Σ gross pay\nDr 6025 Employer Statutory Contributions  Σ (employer NSSF + employer housing levy)\nCr 2200 PAYE Payable                      Σ PAYE\nCr 2210 NSSF Payable                      Σ (employee + employer NSSF)\nCr 2220 SHA Payable                       Σ SHIF\nCr 2230 Housing Levy Payable              Σ (employee + employer levy)\nCr 2120 Net Salaries Payable              Σ net pay\n```\n\n" +
        "**The employee's own deductions are NOT an expense.** They are already inside the gross in 6020 — the business's cost is what the employee EARNED, and PAYE, NSSF, SHIF and the levy are that same money redirected to the authorities instead of to the employee. Only the EMPLOYER's matched contributions are an additional cost, which is why 6025 carries exactly those two. Debiting the employee's deductions as well would double-count the whole payroll.\n\n" +
        "The entry is dated to `payDate`, so **409 if that accounting period is closed**. It is asserted to balance before posting and fails loudly otherwise. **Nothing here touches account 1200, any revenue account, or any stock table.**\n\n" +
        "Paying the net pay out of 2120 is `POST /runs/{id}/settle-net` and remitting the four liabilities is `POST /remittances` (Task 8.2).",
      security: SECURE,
      params: zIdParam,
      response: { 200: zPayrollRunDetail, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const run = await postPayrollRun(request.tenantDb, request.params.id, auth.userId);
        return reply.code(200).send(run);
      } catch (error) {
        return sendPayrollError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/runs/:id/cancel",
    preHandler: [...base, approvalRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Cancel a run that has not been posted",
      description:
        "**409 once the run is POSTED or PAID.** The accrual is booked, every employee has a net-pay claim and three authorities are owed — \"this payroll never happened\" is false, and the correction is a reversing entry.\n\n" +
        "Cancelling frees the month: the one-live-run-per-month index excludes CANCELLED runs, so a corrected payroll can be created for the same period.",
      security: SECURE,
      params: zIdParam,
      body: zCancelRunBody,
      response: { 200: zPayrollRunDetail, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      try {
        const run = await cancelPayrollRun(
          request.tenantDb,
          request.params.id,
          request.body.reason,
        );
        return reply.code(200).send(run);
      } catch (error) {
        return sendPayrollError(reply, error);
      }
    },
  });

  // --- Payslips ------------------------------------------------------------

  api.route({
    method: "GET",
    url: "/runs/:id/payslips",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "The payslips of one run",
      security: SECURE,
      params: zIdParam,
      response: {
        200: z.object({ data: z.array(zPayslip), count: z.number().int() }),
        ...errorResponses(401, 403, 404),
      },
    },
    handler: async (request, reply) => {
      const data = await listPayslipsForRun(request.tenantDb, request.params.id);
      if (data === null) {
        return reply.code(404).send(notFound(`No payroll run with id "${request.params.id}".`));
      }
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/payslips/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "One payslip, with the earnings it was computed from",
      description:
        "The earnings are a COPY of the employee's terms as they stood when the run was computed, not a reference to the live record — so a later salary revision can never restate what this payslip says the employee was paid.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zPayslip, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const payslip = await getPayslip(request.tenantDb, request.params.id);
      if (payslip === null) {
        return reply.code(404).send(notFound(`No payslip with id "${request.params.id}".`));
      }
      return reply.code(200).send(payslip);
    },
  });
  // --- Settlement (Task 8.2) -------------------------------------------------
  //
  // MONEY LEAVING THE BUSINESS, so OWNER / MANAGER only — the same roles that approve
  // and post. Settlement posts liability -> cash and nothing else: no stock table, no
  // 1200, no revenue, no expense.

  api.route({
    method: "POST",
    url: "/runs/:id/settle-net",
    preHandler: [...base, approvalRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Settle a POSTED run's net pay (owner or manager)",
      description:
        "In ONE transaction it posts\n\n" +
        "```\nDr 2120 Net Salaries Payable   Σ the run's payslip net pay\nCr 1000 | 1020 | 1010          by method\n```\n\n" +
        "writes the settlement with ONE audit line per payslip (each employee's own payment method, bank and account SNAPSHOTTED for the bank file a later task builds), and moves the run **POSTED -> PAID**.\n\n" +
        "**The total is derived from the run's frozen payslips, never accepted from the client**, so the settlement pays exactly what was accrued and GL(2120) for the run returns to exactly zero. A deferred database constraint pins it to the payslips, the lines and the 2120 debit at COMMIT.\n\n" +
        "**409** if the run is not POSTED, or has already been settled — one net settlement per run, because a second would pay every employee twice. **404** for a run that is not in your tenant. Nothing here touches stock, 1200, revenue or any expense account.",
      security: SECURE,
      params: zIdParam,
      body: zSettleNetBody,
      response: { 201: zNetPayPayment, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      try {
        const payment = await settleNetPay(request.tenantDb, request.params.id, {
          paymentDate: requireDate(body.paymentDate, "paymentDate"),
          method: body.method,
          ...(body.reference !== undefined ? { reference: body.reference } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          createdById: auth.userId,
        });
        return reply.code(201).send(payment);
      } catch (error) {
        return sendPayrollError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/runs/:id/net-payment",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "The net-pay settlement of one run, with its per-employee lines",
      description: "404 if the run is unknown or has not been settled yet.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zNetPayPayment, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const payment = await getNetPayPaymentForRun(request.tenantDb, request.params.id);
      if (payment === null) {
        return reply
          .code(404)
          .send(notFound(`No net-pay settlement for payroll run "${request.params.id}".`));
      }
      return reply.code(200).send(payment);
    },
  });

  api.route({
    method: "POST",
    url: "/remittances",
    preHandler: [...base, approvalRoles],
    schema: {
      tags: ["Payroll"],
      summary: "Remit one statutory head to its authority (owner or manager)",
      description:
        "Posts ONE balanced two-leg entry:\n\n" +
        "```\nDr 2200 PAYE | 2210 NSSF | 2220 SHA | 2230 Housing Levy   by statutoryType\nCr 1000 | 1020 | 1010                                      by method\n```\n\n" +
        "**400 if it would remit more than is owed** — more than the head's current GL credit balance, or (when tagged to a run) more than that run's accrual credited to the head less what is already remitted against it. Both are re-checked by a deferred database constraint at COMMIT. **404** for a run outside your tenant; **409** if the tagged run has not been posted, or the remittance date falls in a closed period.\n\n" +
        "MPESA records a payment made over M-Pesa; it disburses nothing. A remittance is IMMUTABLE once written.",
      security: SECURE,
      body: zRemittanceBody,
      response: { 201: zStatutoryRemittance, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;
      try {
        const remittance = await recordStatutoryRemittance(request.tenantDb, {
          statutoryType: body.statutoryType,
          amount: parseMoneyToCents(body.amount),
          remittanceDate: requireDate(body.remittanceDate, "remittanceDate"),
          method: body.method,
          ...(body.reference !== undefined ? { reference: body.reference } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.payrollRunId !== undefined ? { payrollRunId: body.payrollRunId } : {}),
          createdById: auth.userId,
        });
        return reply.code(201).send(remittance);
      } catch (error) {
        return sendPayrollError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/remittances",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "List statutory remittances",
      description: "Newest first. Filter by head, by run, and by an inclusive remittance-date range.",
      security: SECURE,
      querystring: zRemittanceQuery,
      response: {
        200: z.object({
          data: z.array(zStatutoryRemittance),
          count: z.number().int(),
          total: zCentsString.meta({ description: "Σ amount over the listed remittances." }),
        }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { statutoryType, payrollRunId, from, to } = request.query;
      try {
        const data = await listStatutoryRemittances(request.tenantDb, {
          ...(statutoryType !== undefined ? { statutoryType } : {}),
          ...(payrollRunId !== undefined ? { payrollRunId } : {}),
          ...(from !== undefined ? { from: requireDate(from, "from") } : {}),
          ...(to !== undefined ? { to: requireDate(to, "to") } : {}),
        });
        const total = data.reduce((sum, r) => sum + r.amount, 0n);
        return reply.code(200).send({ data, count: data.length, total });
      } catch (error) {
        return sendPayrollError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/remittances/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "One statutory remittance",
      security: SECURE,
      params: zIdParam,
      response: { 200: zStatutoryRemittance, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const remittance = await getStatutoryRemittance(request.tenantDb, request.params.id);
      if (remittance === null) {
        return reply
          .code(404)
          .send(notFound(`No statutory remittance with id "${request.params.id}".`));
      }
      return reply.code(200).send(remittance);
    },
  });

  // --- Filing output (Task 8.2) — read-only, recomputes nothing ---------------

  api.route({
    method: "GET",
    url: "/runs/:id/muster",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "The muster roll of one run",
      description:
        "Every payslip, gross through deductions to net, with column totals. Read straight from the stored payslips — nothing is recomputed. `reconciles` is true when every row and the totals satisfy gross − deductions == net and, once posted, the net total equals what the accrual credited to 2120.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zMusterRoll, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const muster = await buildMusterRoll(
        request.tenantDb,
        request.params.id,
        await employerName(request.auth?.tenantId ?? null),
      );
      if (muster === null) {
        return reply.code(404).send(notFound(`No payroll run with id "${request.params.id}".`));
      }
      return reply.code(200).send(muster);
    },
  });

  api.route({
    method: "GET",
    url: "/runs/:id/statutory-summary",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "The four statutory filing schedules of one run",
      description:
        "PAYE (the P10 shape), NSSF, SHIF and the Housing Levy, per employee with totals. **Each schedule ties two ways**: its total against the payslip columns it was summed from AND against what the run's accrual entry credited to the head (2200 / 2210 / 2220 / 2230), with what has been remitted against the run and what remains. An employee missing the identifier an authority files by is named in `missingIdentifiers`, and the summary is then not `fileable`. File formats and direct submission are deferred.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zStatutorySummary, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const summary = await buildStatutorySummary(
        request.tenantDb,
        request.params.id,
        await employerName(request.auth?.tenantId ?? null),
      );
      if (summary === null) {
        return reply.code(404).send(notFound(`No payroll run with id "${request.params.id}".`));
      }
      return reply.code(200).send(summary);
    },
  });

  api.route({
    method: "GET",
    url: "/payslips/:id/document",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Payroll"],
      summary: "One payslip as a structured document",
      description:
        "Employer and employee identity, earnings (basic plus each allowance as snapshotted), the four deductions, PAYE before relief / relief applied / PAYE, employer contributions, net pay, the run period and whether it has been paid. JSON — the frontend renders and prints it. Nothing is recomputed.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zPayslipDocument, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const document = await buildPayslipDocument(
        request.tenantDb,
        request.params.id,
        await employerName(request.auth?.tenantId ?? null),
      );
      if (document === null) {
        return reply.code(404).send(notFound(`No payslip with id "${request.params.id}".`));
      }
      return reply.code(200).send(document);
    },
  });
}
