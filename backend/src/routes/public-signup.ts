// ===========================================================================
// The public business application (M4.5 Wave 2), mounted at /v1/public.
//
// Replaces T-A6.2's one-shot /signup, which would have let an application skip the owner's
// ID document. The application is now a DRAFT the applicant builds in steps and SUBMITS once
// complete:
//
//   POST   /applications                         start a DRAFT -> { applicationId, accessToken }
//   PATCH  /applications/current                 edit (DRAFT or NEEDS_CHANGES)
//   PUT    /applications/current/documents/:side upload the ID's FRONT or BACK (the raw file)
//   POST   /applications/current/submit          DRAFT|NEEDS_CHANGES -> SUBMITTED
//   GET    /applications/current                 the status page's data
//   GET    /onboarding-options                   counties, structures, regimes, tiers
//
// "current" is the application the X-Application-Token header opens — the applicant's bearer
// secret, stored only as its sha256; it never appears in a URL the server sees (the status
// link carries it in the fragment). An unknown or expired token is the one generic 404.
// All are public and on the AUTH rate-limit tier. ENUMERATION-SAFE: a duplicate KRA PIN,
// owner National ID or owner email is never revealed (see services/tenants/applications.ts).
// ===========================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RATE_LIMITS } from "../plugins/security";
import { errorBody, errorResponses, notFound, PUBLIC, zTimestamp } from "../schemas/common";
import { KENYA_COUNTIES } from "../lib/kenya-counties";
import {
  applicantStatus,
  ApplicationLinkError,
  createDraftApplication,
  submitApplicantApplication,
  updateApplicantApplication,
  uploadApplicantDocument,
} from "../services/tenants/applications";
import { BUSINESS_STRUCTURES, SUBSCRIPTION_TIERS, TENANT_TAX_REGIMES, type CandidateError } from "../services/tenants/candidate";
import { DocumentRejectedError, MAX_BYTES } from "../services/tenants/documents";
import { TenantAdminError } from "../services/tenants/tenant-view";
import { zCandidateError, zOnboardingCandidate } from "./tenants";

export const APPLICATION_RECEIVED_MESSAGE =
  "Thank you — your application has been received. We will review it and keep the owner informed by email at each step.";

const TOKEN_HEADER = "x-application-token";

// The applicant's own form requires the owner's phone (stored in E.164; a local number takes +254).
// It is checked by the service, so a missing one is a field error the form can show.
const zApplicationBody = zOnboardingCandidate.omit({ subdomain: true }).extend({
  ownerPhone: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .meta({ description: "Required (a missing one is a 400 naming ownerPhone). Stored in E.164, e.g. +254712345678; a number without a country code is read as Kenyan." }),
});

const zStatus = z.object({
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "NEEDS_CHANGES", "APPROVED", "REJECTED"]),
  application: z.object({
    businessName: z.string(),
    businessStructure: z.string().nullable(),
    registrationNumber: z.string().nullable(),
    businessKraPin: z.string().nullable(),
    kraPin: z.string().nullable(),
    taxRegime: z.string(),
    sector: z.string().nullable(),
    description: z.string().nullable(),
    physicalAddress: z.string().nullable(),
    county: z.string().nullable(),
    permitNumber: z.string().nullable(),
    businessPhone: z.string().nullable(),
    businessEmail: z.string().nullable(),
    requestedTier: z.string().nullable(),
    ownerFullName: z.string(),
    ownerEmail: z.string(),
    ownerPhone: z.string().nullable(),
    ownerNationalIdMasked: z.string().nullable(),
  }),
  documents: z.array(z.object({ side: z.string(), contentType: z.string(), byteSize: z.number().int(), uploadedAt: zTimestamp, deleted: z.boolean() })),
  changesRequested: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  timeline: z.array(
    z.object({
      kind: z.string(),
      message: z.string().nullable(),
      corrections: z.array(z.object({ field: z.string(), from: z.string().nullable(), to: z.string().nullable() })),
      at: zTimestamp,
    }),
  ),
  nextActions: z.array(z.enum(["COMPLETE_AND_SUBMIT", "MAKE_CHANGES_AND_RESUBMIT", "WAIT_FOR_REVIEW", "SIGN_IN_FROM_INVITATION", "APPLY_AGAIN"])),
  editable: z.boolean(),
});

const zTokenHeaders = z.looseObject({
  [TOKEN_HEADER]: z.string().min(16).max(200).meta({ description: "The application's access token. Never logged." }),
});

const zRefused = z.object({ statusCode: z.number().int(), error: z.string(), message: z.string(), errors: z.array(zCandidateError) });

function refused(reply: FastifyReply, errors: readonly CandidateError[]) {
  return reply.code(400).send({
    statusCode: 400,
    error: "BadRequest",
    message: errors.map((e) => `${e.field}: ${e.message}`).join("; "),
    errors: errors.map((e) => ({ ...e })),
  });
}

function sendApplicantError(reply: FastifyReply, error: unknown) {
  if (error instanceof ApplicationLinkError) {
    return reply.code(404).send(notFound(error.message));
  }
  if (error instanceof DocumentRejectedError) {
    return reply.code(400).send(errorBody(400, "BadRequest", error.message));
  }
  if (error instanceof TenantAdminError) {
    return reply.code(error.status).send(errorBody(error.status, error.status === 409 ? "Conflict" : "BadRequest", error.message));
  }
  throw error;
}

const tokenOf = (request: FastifyRequest): string => String(request.headers[TOKEN_HEADER] ?? "");

export async function publicSignupRoutes(app: FastifyInstance): Promise<void> {
  // The ID document arrives as the raw file. The content type here only routes the body to
  // this parser; what the file IS is decided by its bytes (services/tenants/documents.ts).
  app.addContentTypeParser(["image/jpeg", "image/png", "application/pdf"], { parseAs: "buffer", bodyLimit: MAX_BYTES + 1024 }, (_request, body, done) => {
    done(null, body);
  });

  const api = app.withTypeProvider<ZodTypeProvider>();

  api.route({
    method: "GET",
    url: "/onboarding-options",
    schema: {
      tags: ["Tenants"],
      summary: "What the application form offers: counties, structures, tax regimes and tiers",
      security: PUBLIC,
      response: {
        200: z.object({
          counties: z.array(z.string()),
          businessStructures: z.array(z.enum(BUSINESS_STRUCTURES)),
          taxRegimes: z.array(z.string()),
          tiers: z.array(z.string()),
          maxDocumentBytes: z.number().int(),
        }),
      },
    },
    handler: async (_request, reply) =>
      reply.code(200).send({
        counties: [...KENYA_COUNTIES],
        businessStructures: [...BUSINESS_STRUCTURES],
        taxRegimes: [...TENANT_TAX_REGIMES],
        tiers: [...SUBSCRIPTION_TIERS],
        maxDocumentBytes: MAX_BYTES,
      }),
  });

  api.route({
    method: "POST",
    url: "/applications",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Tenants"],
      summary: "Start a business application (public)",
      description:
        "Creates a DRAFT and returns its access token (keep it — it is the only key to the application). Nothing is reserved or created until it is submitted and approved. A malformed field, or a business name already registered, is a 400; every other outcome is the same 201.",
      security: PUBLIC,
      body: zApplicationBody,
      response: { 201: z.object({ applicationId: z.string(), accessToken: z.string() }), 400: zRefused, ...errorResponses(429) },
    },
    handler: async (request, reply) => {
      const outcome = await createDraftApplication(request.body);
      if (outcome.kind === "REFUSED") return refused(reply, outcome.errors);
      return reply.code(201).header("cache-control", "no-store").send({ applicationId: outcome.applicationId, accessToken: outcome.accessToken });
    },
  });

  api.route({
    method: "PATCH",
    url: "/applications/current",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Tenants"],
      summary: "Edit your application (while a draft, or when changes were requested)",
      security: PUBLIC,
      headers: zTokenHeaders,
      body: zApplicationBody.partial(),
      response: { 204: z.void().meta({ description: "Saved." }), 400: zRefused, ...errorResponses(404, 409, 429) },
    },
    handler: async (request, reply) => {
      try {
        const outcome = await updateApplicantApplication(tokenOf(request), request.body);
        if (outcome.kind === "REFUSED") return refused(reply, outcome.errors);
        return reply.code(204).send();
      } catch (error) {
        return sendApplicantError(reply, error);
      }
    },
  });

  api.route({
    method: "PUT",
    url: "/applications/current/documents/:side",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Tenants"],
      summary: "Upload one side of the owner's ID document",
      description:
        "Send the file itself as the body, with Content-Type image/jpeg, image/png or application/pdf, at most 5 MB. It is checked by its CONTENT (not its name), stored encrypted and never shown back. Replaces an earlier upload of the same side.",
      security: PUBLIC,
      headers: zTokenHeaders,
      params: z.object({ side: z.enum(["FRONT", "BACK"]) }),
      response: {
        201: z.object({ side: z.string(), contentType: z.string(), byteSize: z.number().int(), uploadedAt: zTimestamp }),
        ...errorResponses(400, 404, 409, 429),
      },
    },
    handler: async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        return reply.code(400).send(errorBody(400, "BadRequest", "Send the ID document as a JPG, PNG or PDF file."));
      }
      try {
        const meta = await uploadApplicantDocument(tokenOf(request), request.params.side, body, request.headers["content-type"] ?? null);
        return reply.code(201).send({ side: meta.side, contentType: meta.contentType, byteSize: meta.byteSize, uploadedAt: meta.uploadedAt });
      } catch (error) {
        return sendApplicantError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/applications/current/submit",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Tenants"],
      summary: "Submit your application for review",
      description:
        "DRAFT -> SUBMITTED, or NEEDS_CHANGES -> SUBMITTED. Every required field and both sides of the owner's ID must be present (400 naming what is missing). The owner is emailed a status link.",
      security: PUBLIC,
      headers: zTokenHeaders,
      response: { 202: z.object({ message: z.string() }), 400: zRefused, ...errorResponses(404, 409, 429) },
    },
    handler: async (request, reply) => {
      try {
        const outcome = await submitApplicantApplication(tokenOf(request), request.ip);
        if (outcome.kind === "REFUSED") return refused(reply, outcome.errors);
        return reply.code(202).send({ message: APPLICATION_RECEIVED_MESSAGE });
      } catch (error) {
        return sendApplicantError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/applications/current",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Tenants"],
      summary: "Where your application stands",
      description:
        "The status, what was submitted (the National ID masked), what to correct, the decision and its reason, the timeline (including any correction a reviewer made) and the next step. The ID document itself is never returned.",
      security: PUBLIC,
      headers: zTokenHeaders,
      response: { 200: zStatus, ...errorResponses(404, 429) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).header("cache-control", "no-store").send(await applicantStatus(tokenOf(request)));
      } catch (error) {
        return sendApplicantError(reply, error);
      }
    },
  });
}
