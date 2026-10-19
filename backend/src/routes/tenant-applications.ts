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

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RATE_LIMITS } from "../plugins/security";
import { badRequest, errorResponses, SECURE, unauthorized, zTimestamp, zTimestampNullable } from "../schemas/common";
import { approveApplication, listApplications, rejectApplication, reviewApplication } from "../services/tenants/applications";
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

const zApplicationStatus = z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED"]);
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
  status: zApplicationStatus,
  source: zApplicationSource,
  batchId: z.string().nullable(),
  batchRowNumber: z.number().int().nullable(),
  submittedAt: zTimestamp,
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
      description: "Oldest first. Filter by status (e.g. PENDING_APPROVAL) and source.",
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
      summary: "One application, with the green-gate as it stands now",
      security: SECURE,
      params: zIdParams,
      response: { 200: z.object({ application: zApplication, validation: zLiveValidation }), ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      try {
        const { application, validation } = await reviewApplication(request.params.id);
        return reply.code(200).send({
          application,
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
        "SUPER_ADMIN only. Re-runs the green-gate NOW; if anything clashes (a name or PIN taken since submission, a duplicate the public endpoint did not reveal) the approval is refused (409) with the reason and nothing is provisioned. Otherwise passes the billing seam, provisions, invites the owner as MSME_OWNER, and records APPROVED with the resulting tenant.",
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
