// ===========================================================================
// Per-tenant business settings (Task 5.1).
//
// Its own route group because the business profile is NOT a procurement concern:
// it is the tenant's business configuration, and payroll (statutory deduction
// applicability) and reporting (which tax reports apply) will read and extend the
// same singleton. Nesting it under /v1/procurement would have made it look like a
// purchasing setting, which is exactly the misreading that leads to a second copy
// of the same fact somewhere else.
//
// All writes go through src/services/business-profile.ts, the sole writer of the
// table. Nothing here posts to the ledger or moves stock.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getBusinessProfile, updateBusinessProfileMirrored } from "../services/business-profile";
import { platformDb } from "../db/platform";
import {
  getStatutorySchedule,
  getStatutoryScheduleInForce,
  listStatutorySchedules,
} from "../services/payroll";
import {
  supersedeStatutorySchedule,
  StatutoryConfigConflictError,
  StatutoryConfigValidationError,
} from "../services/statutory-schedules";
import { businessToday } from "../lib/business-time";
import { parseMoneyToCents } from "../lib/money";
import { zBusinessProfile, zStatutorySchedule, zTenantTaxRegime } from "../schemas/models";
import {
  badRequest,
  conflict,
  errorResponses,
  isoDateToUtc,
  notFound,
  SECURE,
  unauthorized,
  zIsoDate,
  zMoneyNonNegative,
} from "../schemas/common";

// A RATE on INPUT: a decimal string with at most two places. Never a JSON number and
// never money; range is checked by the service (0–100, and > 0 for VAT/TOT).
const zRateInput = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'must be a percentage as a decimal string, e.g. "16.00".')
  .meta({ type: "string", examples: ["16.00"], description: "A RATE as a decimal-percentage string. Never money, never a JSON number." });

const zSupersedeBody = z.object({
  label: z.string().trim().min(1).optional().meta({ description: 'Defaults to "KE-<effectiveFrom>". Unique across versions.' }),
  effectiveFrom: zIsoDate.meta({
    description:
      "The first business day the new version governs. Must be AFTER the start of the version in force AND after the latest transaction already posted under it (and after the period start of any payroll run computed under it): versions are superseded FORWARD only, so no posted transaction ever changes which rates governed it. The version in force is closed at this date.",
  }),
  source: z.string().meta({ description: "REQUIRED citation for the payroll figures (statute, authority). A blank citation is refused." }),
  verifiedOn: zIsoDate.meta({ description: "REQUIRED. When the figures were verified against that source." }),
  notes: z.string().trim().min(1).optional(),
  personalRelief: zMoneyNonNegative.meta({ description: "Monthly personal relief, a decimal money string." }),
  nssfRatePercent: zRateInput,
  nssfLowerLimit: zMoneyNonNegative,
  nssfUpperLimit: zMoneyNonNegative,
  shifRatePercent: zRateInput,
  shifMinimum: zMoneyNonNegative,
  ahlRatePercent: zRateInput,
  vatStandardRate: zRateInput,
  vatRateSource: z.string().meta({ description: "REQUIRED citation for the VAT rate." }),
  vatRateVerifiedOn: zIsoDate,
  totRatePercent: zRateInput,
  totRateSource: z.string().meta({ description: "REQUIRED citation for the Turnover Tax rate." }),
  totRateVerifiedOn: zIsoDate,
  bands: z
    .array(
      z.object({
        lowerBound: zMoneyNonNegative,
        upperBound: zMoneyNonNegative.nullable().meta({ description: "null for the TOP band only — unbounded above." }),
        ratePercent: zRateInput,
      }),
    )
    .min(1)
    .meta({
      description:
        "The FULL PAYE ladder, lowest first: a contiguous, ascending partition of monthly taxable pay starting at 0, with exactly one open-topped band, at the top. Monthly amounts as decimal money strings.",
    }),
});

function toDate(value: string, field: string): Date {
  const parsed = isoDateToUtc(value);
  if (parsed === null) {
    throw new StatutoryConfigValidationError(`${field} must be YYYY-MM-DD.`);
  }
  return parsed;
}

function sendStatutoryError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof StatutoryConfigValidationError) {
    return reply.code(400).send(badRequest(error.message));
  }
  if (error instanceof StatutoryConfigConflictError) {
    return reply.code(409).send(conflict(error.message));
  }
  throw error;
}

const zUpdateBody = z.object({
  taxRegime: zTenantTaxRegime.optional().meta({
    description:
      "The tenant's tax regime. **This is what decides how a purchase receipt posts**: VAT_REGISTERED capitalises the NET cost and recovers input VAT, while TURNOVER_TAX and EXEMPT capitalise the VAT-INCLUSIVE cost because that tax is never coming back. `isVatRegistered` is DERIVED from this and cannot be set independently — a database CHECK guarantees the two can never disagree.",
  }),
  kraPin: z.string().trim().min(1).nullable().optional().meta({
    description:
      "The business's own KRA PIN as printed on its invoices. Public business identity — not the eTIMS integration credential, which is a secret held in the encrypted store.",
  }),
  // Receipt / display identity (Task T-A13). null clears a field.
  legalName: z.string().trim().min(1).max(200).nullable().optional(),
  addressLine: z.string().trim().min(1).max(300).nullable().optional(),
  phone: z.string().trim().min(1).max(30).nullable().optional(),
  email: z.email().max(320).nullable().optional(),
  receiptFooter: z.string().trim().min(1).max(500).nullable().optional(),
  showLogoOnReceipt: z.boolean().optional(),
});

// Branding (Task T-A13) lives on the tenant's OWN registry row (public.tenants).
const zBranding = z.object({
  brandPrimaryColor: z.string().nullable(),
  brandLogoUrl: z.string().nullable(),
});

const zBrandingUpdate = z
  .object({
    brandPrimaryColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, "a colour is #RRGGBB")
      .nullable()
      .optional()
      .meta({ examples: ["#1F7A4D"] }),
    brandLogoUrl: z.url({ protocol: /^https$/ }).max(2048).nullable().optional().meta({ description: "An https URL to the logo image." }),
  })
  .refine((body) => body.brandPrimaryColor !== undefined || body.brandLogoUrl !== undefined, {
    message: "Supply brandPrimaryColor, brandLogoUrl, or both.",
  });

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];

  // Reading the regime is needed by anyone who has to understand a posting.
  const readRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "ACCOUNTANT",
    "VIEWER_AUDITOR",
  );
  // Changing it changes how every future purchase posts and what the business
  // claims from KRA. That is the owner's decision alone — the same reasoning that
  // makes the integration credentials owner-only.
  const ownerOnly = app.requireRole("MSME_OWNER");

  api.route({
    method: "GET",
    url: "/business-profile",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Settings"],
      summary: "Read this tenant's business profile",
      description:
        "The per-tenant business-configuration singleton: exactly one row per tenant, pinned by a database CHECK so a second is unrepresentable.\n\n" +
        "It is also the home for the statutory flags payroll and reporting will extend, so that a regime-dependent figure is always read from one place rather than copied.",
      security: SECURE,
      response: { 200: zBusinessProfile, ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const profile = await getBusinessProfile(request.tenantDb);
      return reply.code(200).send(profile);
    },
  });

  api.route({
    method: "PUT",
    url: "/business-profile",
    preHandler: [...base, ownerOnly],
    schema: {
      tags: ["Settings"],
      summary: "Set the tax regime, KRA PIN and receipt identity (owner only)",
      description:
        "Omitted fields are left unchanged; null clears an optional field. The receipt fields (legalName, addressLine, phone, email, receiptFooter, showLogoOnReceipt) are what every receipt prints.\n\n" +
        "**THE REGIME IS MIRRORED.** `taxRegime` here is AUTHORITATIVE (posting reads it). The platform registry's copy of this tenant's regime is updated in the SAME transaction, so the two never disagree; nothing posts from the registry copy.\n\n" +
        "**CHANGING `taxRegime` CHANGES HOW EVERY FUTURE PURCHASE RECEIPT POSTS.** A VAT-registered business capitalises the net cost of stock and recovers the input VAT; a non-registered one capitalises the VAT-inclusive cost because that tax is unrecoverable. Both are correct for their regime, and which one applies is this setting.\n\n" +
        "**IT IS NOT RETROACTIVE, deliberately.** It applies to receipts posted from this moment on; stock already received keeps the cost it was received at. Restating the cost of inventory that has already been sold and reported would rewrite settled financial records — a genuinely mis-stated past is corrected with an adjusting entry, never with a silent re-posting.\n\n" +
        "`isVatRegistered` is derived from `taxRegime` and is not settable: a database CHECK guarantees the two can never disagree, because a business wrongly marked registered would recover VAT it is not entitled to and under-declare to KRA.",
      security: SECURE,
      body: zUpdateBody,
      response: { 200: zBusinessProfile, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null || auth.tenantId === null) {
        return reply.code(401).send(unauthorized("Authentication required."));
      }
      const body = request.body;
      const updated = await updateBusinessProfileMirrored(request.tenantDb, auth.tenantId, {
        ...(body.taxRegime !== undefined ? { taxRegime: body.taxRegime } : {}),
        ...(body.kraPin !== undefined ? { kraPin: body.kraPin } : {}),
        ...(body.legalName !== undefined ? { legalName: body.legalName } : {}),
        ...(body.addressLine !== undefined ? { addressLine: body.addressLine } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
        ...(body.receiptFooter !== undefined ? { receiptFooter: body.receiptFooter } : {}),
        ...(body.showLogoOnReceipt !== undefined ? { showLogoOnReceipt: body.showLogoOnReceipt } : {}),
      });
      request.log.info(
        { taxRegime: updated.taxRegime, isVatRegistered: updated.isVatRegistered },
        "business profile updated: this changes how future sales and purchase receipts post",
      );
      return reply.code(200).send(updated);
    },
  });

  // --- Branding (Task T-A13) --------------------------------------------------
  // The tenant's OWN registry row, addressed by the session's tenant id — never a
  // tenant id from the request.

  api.route({
    method: "GET",
    url: "/branding",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["Settings"],
      summary: "Read this business's branding",
      security: SECURE,
      response: { 200: zBranding, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null || auth.tenantId === null) return reply.code(401).send(unauthorized("Authentication required."));
      const branding = await platformDb.tenant.findUnique({
        where: { id: auth.tenantId },
        select: { brandPrimaryColor: true, brandLogoUrl: true },
      });
      if (branding === null) return reply.code(404).send(notFound("Tenant not found."));
      return reply.code(200).send(branding);
    },
  });

  api.route({
    method: "PUT",
    url: "/branding",
    preHandler: [...base, ownerOnly],
    schema: {
      tags: ["Settings"],
      summary: "Set this business's brand colour and logo URL (owner only)",
      description: "Omitted fields are left unchanged; null clears one. The receipt prints the logo when showLogoOnReceipt is true.",
      security: SECURE,
      body: zBrandingUpdate,
      response: { 200: zBranding, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null || auth.tenantId === null) return reply.code(401).send(unauthorized("Authentication required."));
      const body = request.body;
      const updated = await platformDb.tenant.update({
        where: { id: auth.tenantId },
        data: {
          ...(body.brandPrimaryColor !== undefined ? { brandPrimaryColor: body.brandPrimaryColor } : {}),
          ...(body.brandLogoUrl !== undefined ? { brandLogoUrl: body.brandLogoUrl } : {}),
        },
        select: { brandPrimaryColor: true, brandLogoUrl: true },
      });
      return reply.code(200).send(updated);
    },
  });

  // --- Statutory configuration (Task 3B.3) -----------------------------------
  //
  // SUPERSEDE-FORWARD, NEVER MUTATE-IN-PLACE. There is no PUT, PATCH or DELETE on a
  // version: a rate change is a NEW effective-dated version, and a version any
  // transaction used is frozen by the database. Writing is the OWNER's alone — these
  // figures decide what every employee is paid and what the business declares to KRA.
  const statutoryReadRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT");

  api.route({
    method: "GET",
    url: "/statutory-schedules",
    preHandler: [...base, statutoryReadRoles],
    schema: {
      tags: ["Settings"],
      summary: "Every statutory schedule version — the full history",
      description:
        "Newest first. Each version is a complete ruleset (PAYE bands, personal relief, NSSF, SHIF, housing levy, the standard VAT rate and the Turnover Tax rate) over a half-open window [effectiveFrom, effectiveTo); exactly one covers any date. createdById is null for the system seed.",
      security: SECURE,
      response: { 200: z.object({ data: z.array(zStatutorySchedule), count: z.number().int() }), ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const data = await listStatutorySchedules(request.tenantDb);
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/statutory-schedules/current",
    preHandler: [...base, statutoryReadRoles],
    schema: {
      tags: ["Settings"],
      summary: "The statutory schedule in force today",
      description: "The version whose window contains today's business date (Africa/Nairobi). The settings UI prefills a new version from this.",
      security: SECURE,
      response: { 200: zStatutorySchedule, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const today = businessToday();
      const current = await getStatutoryScheduleInForce(request.tenantDb, today);
      if (current === null) {
        return reply.code(404).send(notFound(`No statutory schedule covers ${today.toISOString().slice(0, 10)}.`));
      }
      return reply.code(200).send(current);
    },
  });

  api.route({
    method: "POST",
    url: "/statutory-schedules",
    preHandler: [...base, ownerOnly],
    schema: {
      tags: ["Settings"],
      summary: "Supersede the statutory schedule from a future commencement date (owner only)",
      description:
        "Creates a NEW version — a COMPLETE ruleset; prefill from `/current` and override what the law changed — effective from `effectiveFrom`, and in the SAME transaction closes the version in force at that date (its last day becomes the day before). **Forward-only**: refused with 409 if `effectiveFrom` is not after the start of the version in force, after the latest transaction already posted under it, and after the period start of any payroll run computed under it. Nothing already posted is recomputed — every sale, bill and payslip keeps the rates that governed it.\n\n" +
        "400 on a blank citation, a missing verification date, an out-of-range rate (0–100%; VAT and TOT must be > 0) or a PAYE ladder that is not a contiguous partition from 0 with one open top. Money and rates are decimal strings; a JSON number is rejected.",
      security: SECURE,
      body: zSupersedeBody,
      response: { 201: zStatutorySchedule, ...errorResponses(400, 401, 403, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(unauthorized("Authentication required."));
      }
      const b = request.body;
      try {
        const id = await supersedeStatutorySchedule(request.tenantDb, {
          ...(b.label !== undefined ? { label: b.label } : {}),
          effectiveFrom: toDate(b.effectiveFrom, "effectiveFrom"),
          source: b.source,
          verifiedOn: toDate(b.verifiedOn, "verifiedOn"),
          ...(b.notes !== undefined ? { notes: b.notes } : {}),
          personalRelief: parseMoneyToCents(b.personalRelief),
          nssfRatePercent: b.nssfRatePercent,
          nssfLowerLimit: parseMoneyToCents(b.nssfLowerLimit),
          nssfUpperLimit: parseMoneyToCents(b.nssfUpperLimit),
          shifRatePercent: b.shifRatePercent,
          shifMinimum: parseMoneyToCents(b.shifMinimum),
          ahlRatePercent: b.ahlRatePercent,
          vatStandardRate: b.vatStandardRate,
          vatRateSource: b.vatRateSource,
          vatRateVerifiedOn: toDate(b.vatRateVerifiedOn, "vatRateVerifiedOn"),
          totRatePercent: b.totRatePercent,
          totRateSource: b.totRateSource,
          totRateVerifiedOn: toDate(b.totRateVerifiedOn, "totRateVerifiedOn"),
          bands: b.bands.map((band) => ({
            lowerBound: parseMoneyToCents(band.lowerBound),
            upperBound: band.upperBound === null ? null : parseMoneyToCents(band.upperBound),
            ratePercent: band.ratePercent,
          })),
          createdById: auth.userId,
        });
        const created = await getStatutorySchedule(request.tenantDb, id);
        if (created === null) {
          throw new Error(`Statutory schedule ${id} was created but cannot be read back.`);
        }
        request.log.info({ scheduleId: id, label: created.label, effectiveFrom: b.effectiveFrom }, "statutory schedule superseded");
        return reply.code(201).send(created);
      } catch (error) {
        return sendStatutoryError(reply, error);
      }
    },
  });
}
