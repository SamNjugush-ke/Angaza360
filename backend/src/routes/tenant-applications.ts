// ===========================================================================
// The tenant-application approval queue (Task T-A6.2), mounted at /v1/tenant-applications.
//
// PLATFORM-SCOPED: SUPER_ADMIN and PROGRAM_OFFICER read, review and reject; APPROVING —
// which provisions the business and invites its owner — is SUPER_ADMIN only (the T-A5
// role-assignment rule). A tenant user is refused everywhere.
//
// Reading one application re-runs the green-gate as things stand NOW, so a reviewer sees a
// clash that appeared after submission (or a duplicate the public endpoint did not reveal)
// before deciding. Approval re-runs it again and refuses (409) with the reason.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RATE_LIMITS } from "../plugins/security";
import { badRequest, errorResponses, SECURE, unauthorized, zTimestamp, zTimestampNullable } from "../schemas/common";
import {
  approveApplication,
  correctApplication,
  listApplications,
  rejectApplication,
  requestChanges,
  reviewApplication,
  startReview,
} from "../services/tenants/applications";
import { issueDocumentView, redeemDocumentView } from "../services/tenants/documents";
import {
  commitBatch,
  editBatchRow,
  onboardingCsvTemplate,
  previewBatch,
  removeBatchRow,
  uploadBatch,
} from "../services/tenants/batch";
import { CsvFileError } from "../services/csv/import";
import { actorOf, sendTenantAdminError, zCandidateError, zOnboardedTenant, zOnboardingCandidate } from "./tenants";

const zApplicationStatus = z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "NEEDS_CHANGES", "APPROVED", "REJECTED"]);
const zApplicationSource = z.enum(["SELF_SERVE", "ADMIN", "BATCH"]);

export const zApplication = z.object({
  id: z.string(),
  businessName: z.string(),
  proposedSubdomain: z.string().nullable(),
  sector: z.string().nullable(),
  kraPin: z.string().nullable(),
  taxRegime: z.string(),
  requestedTier: z.string().nullable(),
  ownerFullName: z.string(),
  ownerEmail: z.string(),
  ownerPhone: z.string().nullable(),
  ownerNationalId: z.string().nullable(),
  businessStructure: z.string().nullable(),
  registrationNumber: z.string().nullable(),
  businessKraPin: z.string().nullable(),
  description: z.string().nullable(),
  physicalAddress: z.string().nullable(),
  county: z.string().nullable(),
  permitNumber: z.string().nullable(),
  businessPhone: z.string().nullable(),
  businessEmail: z.string().nullable(),
  formVersion: z.number().int(),
  status: zApplicationStatus,
  source: zApplicationSource,
  batchId: z.string().nullable(),
  batchRowNumber: z.number().int().nullable(),
  createdAt: zTimestamp,
  submittedAt: zTimestamp,
  reviewerUserId: z.string().nullable(),
  reviewStartedAt: zTimestampNullable,
  changesRequested: z.string().nullable(),
  reviewedById: z.string().nullable(),
  reviewedAt: zTimestampNullable,
  rejectionReason: z.string().nullable(),
  resultingTenantId: z.string().nullable(),
});

export const zLiveValidation = z
  .object({ status: z.enum(["GREEN", "RED"]), errors: z.array(zCandidateError), proposedSubdomain: z.string().nullable() })
  .nullable()
  .meta({ description: "The green-gate as things stand NOW; null once decided." });

const zIdParams = z.object({ id: z.string().min(1) });

// The ID document as an ordinary response may show it: NEVER its bytes, hash or cipher parts.
const zDocumentMeta = z.object({
  id: z.string(),
  side: z.enum(["FRONT", "BACK"]),
  contentType: z.string(),
  byteSize: z.number().int(),
  uploadedAt: zTimestamp,
  purgedAt: zTimestampNullable,
});

const zTimelineEvent = z.object({
  kind: z.string(),
  actorUserId: z.string().nullable(),
  message: z.string().nullable(),
  details: z.unknown(),
  occurredAt: zTimestamp,
});

// Administrative details a reviewer may correct; anything else is refused by the schema.
const zCorrection = z
  .object({
    sector: z.string().max(200).nullable().optional(),
    description: z.string().max(1200).nullable().optional(),
    physicalAddress: z.string().max(400).nullable().optional(),
    county: z.string().max(60).nullable().optional(),
    permitNumber: z.string().max(80).nullable().optional(),
    businessPhone: z.string().max(40).nullable().optional(),
    businessEmail: z.string().max(400).nullable().optional(),
    requestedTier: z.string().max(40).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional().meta({ description: "Why — shown to the applicant." }),
  })
  .strict();
const zBatchParams = z.object({ batchId: z.string().min(1) });

const zBatch = z.object({
  id: z.string(),
  uploadedById: z.string(),
  status: z.enum(["PREVIEW", "COMMITTED"]),
  createdAt: zTimestamp,
  committedAt: zTimestampNullable,
});

const zPreviewRow = z.object({
  application: zApplication,
  status: z.enum(["GREEN", "RED"]),
  errors: z.array(zCandidateError),
  proposedSubdomain: z.string().nullable(),
});

const zBatchPreview = z.object({
  batch: zBatch,
  rows: z.array(zPreviewRow),
  allGreen: z.boolean().meta({ description: "True only when there is at least one row and EVERY row is GREEN — the commit gate." }),
});

const zRowEdit = zOnboardingCandidate.partial();

export async function tenantApplicationRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const platformStaff = [app.requireAuth, app.requireRole("SUPER_ADMIN", "PROGRAM_OFFICER")];

  api.route({
    method: "GET",
    url: "/",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "The application queue",
      description: "Oldest first. Filter by status (e.g. SUBMITTED) and source. A DRAFT — the applicant's unfinished form — is never listed.",
      security: SECURE,
      querystring: z.object({ status: zApplicationStatus.optional(), source: zApplicationSource.optional() }),
      response: { 200: z.object({ data: z.array(zApplication) }), ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const data = await listApplications({ status: request.query.status ?? null, source: request.query.source ?? null });
      return reply.code(200).send({ data });
    },
  });

  api.route({
    method: "GET",
    url: "/:id",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "One application, its documents (metadata only), its timeline and the green-gate as it stands now",
      security: SECURE,
      params: zIdParams,
      response: {
        200: z.object({ application: zApplication, validation: zLiveValidation, documents: z.array(zDocumentMeta), timeline: z.array(zTimelineEvent) }),
        ...errorResponses(401, 403, 404),
      },
    },
    handler: async (request, reply) => {
      try {
        const { application, validation, documents, timeline } = await reviewApplication(request.params.id);
        return reply.code(200).send({
          application,
          documents: documents.map((doc) => ({ ...doc })),
          timeline,
          validation:
            validation === null
              ? null
              : { status: validation.status, errors: [...validation.errors], proposedSubdomain: validation.proposedSubdomain },
        });
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/approve",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [app.requireAuth, app.requireRole("SUPER_ADMIN")],
    schema: {
      tags: ["Tenants"],
      summary: "Approve an application: provision the business and invite its owner",
      description:
        "SUPER_ADMIN only, on an application UNDER_REVIEW. Re-runs the green-gate NOW; if anything clashes (a name or PIN taken since submission, a duplicate the public endpoint did not reveal) the approval is refused (409) with the reason and nothing is provisioned. Otherwise passes the billing seam, provisions, invites the owner as MSME_OWNER, and records APPROVED with the resulting tenant.",
      security: SECURE,
      params: zIdParams,
      response: {
        200: z.object({ application: zApplication, onboarded: zOnboardedTenant }),
        ...errorResponses(401, 403, 404, 409, 429),
      },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await approveApplication(actor, request.params.id));
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  // ---- The review (M4.5 W2) ------------------------------------------------------

  api.route({
    method: "POST",
    url: "/:id/start-review",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Open the review of a submitted application",
      description:
        "SUBMITTED -> UNDER_REVIEW. You become its reviewing officer — with a SUPER_ADMIN, the only person who may view its ID document. The applicant is told.",
      security: SECURE,
      params: zIdParams,
      response: { 200: zApplication, ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await startReview(actor, request.params.id));
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/request-changes",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Send the application back to the applicant with what to change",
      description:
        "UNDER_REVIEW -> NEEDS_CHANGES. The message reaches the applicant (with their status link); they change it and resubmit. This is how an identity or ownership detail is corrected — never by the reviewer.",
      security: SECURE,
      params: zIdParams,
      body: z.object({ message: z.string().trim().min(5).max(2000) }),
      response: { 200: zApplication, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await requestChanges(actor, request.params.id, request.body.message));
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  api.route({
    method: "PATCH",
    url: "/:id/corrections",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Correct an administrative detail, transparently",
      description:
        "On an application UNDER_REVIEW: only sector, description, physical address, county, permit number, business phone and email, and the requested tier. Each change is shown to the applicant on their status page and audited. Identity and ownership fields are refused — request changes instead.",
      security: SECURE,
      params: zIdParams,
      body: zCorrection,
      response: { 200: zApplication, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      const { note, ...patch } = request.body;
      try {
        return reply.code(200).send(await correctApplication(actor, request.params.id, patch, note ?? null));
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/documents/:documentId/view-grant",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Ask to view the owner's ID document (single-use, short-lived)",
      description:
        "SUPER_ADMIN, or the officer reviewing THIS application — nobody else. Returns a single-use token valid for two minutes, for you alone; open it at GET /documents/view/{token}. Both steps are audited.",
      security: SECURE,
      params: z.object({ id: z.string().min(1), documentId: z.string().min(1) }),
      response: { 200: z.object({ token: z.string(), expiresAt: zTimestamp }), ...errorResponses(401, 403, 404, 409, 429) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        const grant = await issueDocumentView(actor, request.params.id, request.params.documentId);
        return reply.code(200).header("cache-control", "no-store").send(grant);
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/documents/view/:token",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "View the ID document once, with a view grant",
      description:
        "The decrypted file, ONCE, for the person the grant was issued to — no-store, inline, sandboxed. A used, expired or someone else's grant is 404.",
      security: SECURE,
      params: z.object({ token: z.string().min(1) }),
      // THE ONE BINARY RESPONSE: 200 is the raw file (image/jpeg, image/png or application/pdf),
      // so it has no JSON schema; every error keeps the one error shape.
      response: { ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        const file = await redeemDocumentView(actor, request.params.token);
        // The raw file: no JSON schema governs a 200 here (see the response map).
        return (reply as FastifyReply)
          .code(200)
          .type(file.contentType)
          .header("cache-control", "no-store, private")
          .header("content-disposition", "inline")
          .header("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:")
          .send(file.bytes);
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/reject",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Reject an application, recording the reason",
      security: SECURE,
      params: zIdParams,
      body: z.object({ reason: z.string().trim().min(1).max(1000) }),
      response: { 200: zApplication, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await rejectApplication(actor, request.params.id, request.body.reason));
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  // ---- Batch CSV onboarding (Task T-A6.3) ----------------------------------------
  // validate -> preview -> commit over the generic CSV framework. Upload, preview, row
  // correction and removal: SUPER_ADMIN or PROGRAM_OFFICER. Commit — which provisions
  // and invites — SUPER_ADMIN only.

  api.route({
    method: "GET",
    url: "/batch/template",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Download the onboarding CSV template",
      description:
        "A text/csv file holding the header row: businessName, subdomain, sector, kraPin, taxRegime, requestedTier, ownerFullName, ownerEmail, ownerPhone, ownerNationalId. Required: businessName, taxRegime, ownerFullName, ownerEmail.",
      security: SECURE,
      response: { 200: z.string().meta({ description: "text/csv" }), ...errorResponses(401, 403) },
    },
    handler: async (_request, reply) =>
      reply
        .code(200)
        .type("text/csv; charset=utf-8")
        .header("content-disposition", "attachment; filename=onboarding-template.csv")
        .serializer((payload: unknown) => String(payload))
        .send(onboardingCsvTemplate()),
  });

  api.route({
    method: "POST",
    url: "/batch",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Upload an onboarding CSV (text/csv body) and preview it",
      description:
        "Send the CSV as the request body with Content-Type: text/csv. A file-level problem (unknown or missing column, malformed CSV, too many rows) is a 400 and stores nothing. Otherwise every row is stored as a PREVIEW batch row and validated — including within-file duplicates — and NOTHING is provisioned.",
      security: SECURE,
      body: z.string().meta({ description: "The CSV text." }),
      response: { 201: zBatchPreview, ...errorResponses(400, 401, 403, 429) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(201).send(await uploadBatch(actor, request.body));
      } catch (error) {
        if (error instanceof CsvFileError) {
          return reply.code(400).send(badRequest(error.message));
        }
        return sendTenantAdminError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/batch/:batchId",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Preview a batch: every row GREEN or its errors, and whether all are green",
      security: SECURE,
      params: zBatchParams,
      response: { 200: zBatchPreview, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await previewBatch(request.params.batchId));
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/batch/:batchId/commit",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [app.requireAuth, app.requireRole("SUPER_ADMIN")],
    schema: {
      tags: ["Tenants"],
      summary: "Commit a batch: provision and invite every row — only if EVERY row is green",
      description:
        "SUPER_ADMIN only. THE BATCH GREEN-GATE: re-validates every remaining row now and refuses (409, naming the rows) unless all are GREEN. Then provisions each business and invites its owner. Idempotent: a committed batch provisions nothing new, and an interrupted commit resumes with the rows not yet provisioned.",
      security: SECURE,
      params: zBatchParams,
      response: {
        200: z.object({ batch: zBatch, alreadyCommitted: z.boolean(), onboarded: z.array(zOnboardedTenant) }),
        ...errorResponses(401, 403, 404, 409, 429),
      },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await commitBatch(actor, request.params.batchId));
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  api.route({
    method: "PATCH",
    url: "/:id",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Correct a batch row, and re-validate it",
      description: "Only a row of a PREVIEW batch. Returns the row as the batch preview now judges it.",
      security: SECURE,
      params: zIdParams,
      body: zRowEdit,
      response: { 200: zPreviewRow, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await editBatchRow(request.params.id, request.body));
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  api.route({
    method: "DELETE",
    url: "/:id",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Remove a batch row",
      description: "Only a row of a PREVIEW batch.",
      security: SECURE,
      params: zIdParams,
      response: { 204: z.void().meta({ description: "Removed." }), ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      try {
        await removeBatchRow(request.params.id);
        return reply.code(204).send();
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });
}
