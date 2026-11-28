// ===========================================================================
// The report library routes (M4.5 W4): one registration, two mounts.
//
//   /v1/report-library    a business's OWN reports (requireAuth + requireTenant; the session's
//                         tenant only) — what the T-B4 self-service export screen drives
//   /v1/platform-reports  platform reports (SUPER_ADMIN / PROGRAM_OFFICER; tenantless sessions)
//
// On each:  GET /                         the reports this role may run, with their filters
//           GET /{id}?filters&take&skip    the report, as shown on screen (paginated)
//           GET /{id}/export?format&filters  the SAME document as .xlsx / .csv / .pdf — streamed
//                                         when small, or 202 with an export to collect when large
//           GET /exports, /exports/{id}, /exports/{id}/download   the requester's own background
//                                         exports (anyone else's is 404), downloadable until expiry
// Every export and every background download is audited. Reports are on the SENSITIVE rate tier.
// A report the role may not run is 404 — the library does not confirm it exists.
// ===========================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { platformDb } from "../db/platform";
import { RATE_LIMITS } from "../plugins/security";
import { getBusinessProfile } from "../services/business-profile";
import type { Brand } from "../services/export/model";
import {
  downloadExport,
  EXPORT_FORMATS,
  ExportNotFoundError,
  ExportUnavailableError,
  exportDocument,
  getExport,
  listExports,
  type ExportStore,
  type ExportView,
} from "../services/export/files";
import {
  catalogueOf,
  findReport,
  ReportFilterError,
  ReportNotFoundError,
  viewOf,
  type PlatformContext,
  type Query,
  type ReportDefinition,
  type TenantContext,
} from "../services/reports-library/library";
import { PLATFORM_REPORTS } from "../services/reports-library/platform-reports";
import { TENANT_REPORTS } from "../services/reports-library/tenant-reports";
import { ReportValidationError } from "../services/reports";
import { badRequest, conflict, errorResponses, notFound, SECURE, unauthorized, zIdParam, zTimestamp, zTimestampNullable } from "../schemas/common";
import type { UserRole } from "../generated/platform/client";

/** Every filter a report may read; each report validates the ones it uses. */
const FILTER_KEYS = [
  "from", "to", "asOf", "status", "tenderType", "locationId", "customerId", "supplierId", "productId", "movementType", "q",
  "by", "limit", "belowReorder", "owing", "method", "category", "includeVoided", "comparative", "months", "year", "runId",
  "outcome", "tier", "county", "sector", "source", "role", "tenantId", "active", "action", "projectId", "consent",
  "provider", "channel", "template",
] as const;

const zFilters = z.object(Object.fromEntries(FILTER_KEYS.map((key) => [key, z.string().max(200).optional()])) as Record<(typeof FILTER_KEYS)[number], z.ZodOptional<z.ZodString>>);

const zFilterSpec = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["date", "select", "search", "entity", "number"]),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  entity: z.string().optional(),
  defaultHint: z.string().optional(),
  required: z.boolean().optional(),
});

const zCatalogue = z.object({
  data: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), category: z.string(), sensitive: z.boolean(), filters: z.array(zFilterSpec) })),
});

const zView = z
  .object({
    reportId: z.string(),
    title: z.string(),
    brandName: z.string(),
    filters: z.array(z.object({ label: z.string(), value: z.string() })),
    period: z.object({ from: z.string(), to: z.string() }).nullable(),
    generatedAt: zTimestamp,
    sections: z.array(
      z.object({
        name: z.string(),
        note: z.string().nullable(),
        columns: z.array(z.object({ key: z.string(), header: z.string(), kind: z.enum(["text", "money", "quantity", "integer", "percent", "date", "datetime"]), total: z.boolean() })),
        totalRows: z.number().int(),
        rows: z.array(z.record(z.string(), z.string().nullable())).meta({ description: "Money as a string of cents; a quantity or percent as a decimal string; a business date YYYY-MM-DD; an instant ISO 8601." }),
        totals: z.record(z.string(), z.string()).nullable().meta({ description: "Per totalled column: cents for money, the exact sum otherwise." }),
      }),
    ),
  })
  .meta({ id: "ReportView" });

const zExport = z
  .object({ id: z.string(), reportId: z.string(), format: z.string(), status: z.enum(["PENDING", "READY", "FAILED", "EXPIRED"]), rowCount: z.number().int(), filename: z.string().nullable(), byteSize: z.number().int().nullable(), error: z.string().nullable(), createdAt: zTimestamp, finishedAt: zTimestampNullable, expiresAt: zTimestamp })
  .meta({ id: "ReportExport" });

const exportView = (row: ExportView) => ({ ...row, status: row.status as "PENDING" | "READY" | "FAILED" | "EXPIRED" });

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ReportNotFoundError || error instanceof ExportNotFoundError) return reply.code(404).send(notFound(error.message));
  if (error instanceof ReportFilterError || error instanceof ReportValidationError) return reply.code(400).send(badRequest(error.message));
  if (error instanceof ExportUnavailableError) return reply.code(409).send(conflict(error.message));
  throw error;
}

function sendFile(reply: FastifyReply, file: { body: Buffer; contentType: string; filename: string }): FastifyReply {
  return reply
    .code(200)
    .type(file.contentType)
    .header("cache-control", "no-store, private")
    .header("x-content-type-options", "nosniff")
    .header("content-disposition", `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`)
    .send(file.body);
}

interface Mount<C> {
  tag: string;
  reports: ReadonlyArray<ReportDefinition<C>>;
  /** The run context for this request, or null (401). */
  contextOf: (request: FastifyRequest) => Promise<C | null>;
  storeOf: (request: FastifyRequest) => ExportStore;
  role: (context: C) => UserRole;
  userId: (context: C) => string;
}

function libraryRoutes<C>(mount: Mount<C>, preHandler: readonly preHandlerHookHandler[]) {
  return async (app: FastifyInstance): Promise<void> => {
    const api = app.withTypeProvider<ZodTypeProvider>();
    const sensitive = { rateLimit: RATE_LIMITS.SENSITIVE };

    api.route({
      method: "GET",
      url: "/",
      preHandler: [...preHandler],
      schema: { tags: [mount.tag], summary: "The reports this role may run, with their filters", security: SECURE, response: { 200: zCatalogue, ...errorResponses(401, 403) } },
      handler: async (request, reply) => {
        const context = await mount.contextOf(request);
        if (context === null) return reply.code(401).send(unauthorized("Authentication required."));
        return reply.code(200).send({ data: catalogueOf(mount.reports, mount.role(context)) });
      },
    });

    api.route({
      method: "GET",
      url: "/exports",
      preHandler: [...preHandler],
      schema: { tags: [mount.tag], summary: "Your background exports (newest first)", security: SECURE, response: { 200: z.object({ data: z.array(zExport) }), ...errorResponses(401, 403) } },
      handler: async (request, reply) => {
        const context = await mount.contextOf(request);
        if (context === null) return reply.code(401).send(unauthorized("Authentication required."));
        return reply.code(200).send({ data: (await listExports(mount.storeOf(request), mount.userId(context))).map(exportView) });
      },
    });

    api.route({
      method: "GET",
      url: "/exports/:id",
      preHandler: [...preHandler],
      schema: { tags: [mount.tag], summary: "One of your background exports", security: SECURE, params: zIdParam, response: { 200: zExport, ...errorResponses(401, 403, 404) } },
      handler: async (request, reply) => {
        const context = await mount.contextOf(request);
        if (context === null) return reply.code(401).send(unauthorized("Authentication required."));
        try {
          return reply.code(200).send(exportView(await getExport(mount.storeOf(request), request.params.id, mount.userId(context))));
        } catch (error) {
          return sendError(reply, error);
        }
      },
    });

    api.route({
      method: "GET",
      url: "/exports/:id/download",
      preHandler: [...preHandler],
      config: sensitive,
      schema: {
        tags: [mount.tag],
        summary: "Download one of your READY exports",
        description: "The file, for the person who asked for it, until it expires (then 409: run it again). Audited. A binary response: no JSON schema governs the 200.",
        security: SECURE,
        params: zIdParam,
        response: { ...errorResponses(401, 403, 404, 409, 429) },
      },
      handler: async (request, reply) => {
        const context = await mount.contextOf(request);
        if (context === null) return reply.code(401).send(unauthorized("Authentication required."));
        try {
          const file = await downloadExport(mount.storeOf(request), request.params.id, mount.userId(context), request.ip);
          return sendFile(reply as FastifyReply, file);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    });

    api.route({
      method: "GET",
      url: "/:id",
      preHandler: [...preHandler],
      config: sensitive,
      schema: {
        tags: [mount.tag],
        summary: "Run a report with its filters (as shown on screen)",
        security: SECURE,
        params: z.object({ id: z.string().min(1).max(60) }),
        querystring: zFilters.extend({ take: z.coerce.number().int().min(1).max(500).default(100), skip: z.coerce.number().int().min(0).default(0) }),
        response: { 200: zView, ...errorResponses(400, 401, 403, 404, 429) },
      },
      handler: async (request, reply) => {
        const context = await mount.contextOf(request);
        if (context === null) return reply.code(401).send(unauthorized("Authentication required."));
        try {
          const report = findReport(mount.reports, request.params.id, mount.role(context));
          const { take, skip, ...filters } = request.query;
          const document = await report.run(context, filters as Query);
          return reply.code(200).header("cache-control", "no-store").send(viewOf(document, take, skip));
        } catch (error) {
          return sendError(reply, error);
        }
      },
    });

    api.route({
      method: "GET",
      url: "/:id/export",
      preHandler: [...preHandler],
      config: sensitive,
      schema: {
        tags: [mount.tag],
        summary: "Export a report — exactly the filtered view — as .xlsx, .csv or .pdf",
        description:
          "Builds the SAME document the report screen shows, from the same filters, and renders it. Small: the file itself (200, attachment, no-store). Large (more rows than EXPORT_SYNC_MAX_ROWS, default 5,000): 202 with an export to collect from /exports/{id} and download once READY. Text cells are neutralised against spreadsheet formula injection. Every export is audited.",
        security: SECURE,
        params: z.object({ id: z.string().min(1).max(60) }),
        querystring: zFilters.extend({ format: z.enum(EXPORT_FORMATS as unknown as ["xlsx", "csv", "pdf"]) }),
        response: { 202: zExport, ...errorResponses(400, 401, 403, 404, 429) },
      },
      handler: async (request, reply) => {
        const context = await mount.contextOf(request);
        if (context === null) return reply.code(401).send(unauthorized("Authentication required."));
        try {
          const report = findReport(mount.reports, request.params.id, mount.role(context));
          const { format, ...filters } = request.query;
          const document = await report.run(context, filters as Query);
          const outcome = await exportDocument(mount.storeOf(request), document, {
            reportId: report.id,
            format,
            filters: document.period ? [{ label: "Period", value: `${document.period.from} to ${document.period.to}` }, ...document.filters] : document.filters,
            sensitive: report.sensitive,
            actorUserId: mount.userId(context),
            ipAddress: request.ip,
          });
          if (outcome.mode === "stream") return sendFile(reply as FastifyReply, outcome.file);
          return reply.code(202).send(exportView(outcome.export));
        } catch (error) {
          return sendError(reply, error);
        }
      },
    });
  };
}

/** The business's own brand for its documents: legal name (or name), colour and KRA PIN. */
async function tenantBrand(request: FastifyRequest): Promise<{ brand: Brand; name: string }> {
  const tenantId = request.auth?.tenantId ?? "";
  const [registry, profile] = await Promise.all([
    platformDb.tenant.findUnique({ where: { id: tenantId }, select: { name: true, brandPrimaryColor: true, kraPin: true } }),
    getBusinessProfile(request.tenantDb),
  ]);
  const name = profile.legalName ?? registry?.name ?? "Your business";
  const pin = profile.kraPin ?? registry?.kraPin ?? null;
  const detail = [pin ? `KRA PIN ${pin}` : null, profile.addressLine].filter((part): part is string => part !== null && part !== "").join("  ");
  return { brand: { name, color: registry?.brandPrimaryColor ?? "#006078", ...(detail !== "" ? { detail } : {}) }, name: registry?.name ?? name };
}

export async function tenantReportRoutes(app: FastifyInstance): Promise<void> {
  const mount: Mount<TenantContext> = {
    tag: "Reports",
    reports: TENANT_REPORTS,
    contextOf: async (request) => {
      const auth = request.auth;
      if (auth === null || auth.tenantId === null) return null;
      const { brand, name } = await tenantBrand(request);
      return { db: request.tenantDb, tenantId: auth.tenantId, userId: auth.userId, role: auth.role, brand, businessName: name };
    },
    storeOf: (request) => ({ kind: "tenant", db: request.tenantDb, tenantId: request.auth?.tenantId ?? "" }),
    role: (context) => context.role,
    userId: (context) => context.userId,
  };
  await libraryRoutes(mount, [app.requireAuth, app.requireTenant])(app);
}

export async function platformReportRoutes(app: FastifyInstance): Promise<void> {
  const mount: Mount<PlatformContext> = {
    tag: "Platform reports",
    reports: PLATFORM_REPORTS,
    contextOf: async (request) => (request.auth === null ? null : { userId: request.auth.userId, role: request.auth.role }),
    storeOf: () => ({ kind: "platform" }),
    role: (context) => context.role,
    userId: (context) => context.userId,
  };
  await libraryRoutes(mount, [app.requireAuth, app.requireRole("SUPER_ADMIN", "PROGRAM_OFFICER")])(app);
}
