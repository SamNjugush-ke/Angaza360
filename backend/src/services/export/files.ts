// ===========================================================================
// RENDERING AND DELIVERING AN EXPORT (M4.5 W4).
//
// One entry point for every report, tenant or platform: render the document in the format asked
// for, then either STREAM it (small) or build it in the BACKGROUND (large) into an encrypted export
// file that only the requester may download, and only until it expires. Every export — streamed
// or not — is AUDITED (`REPORT_EXPORTED`: who, which report, which format, which filters, how many
// rows; never the data), and so is a background file's download.
//
// WHERE A FILE LIVES: a business's export in ITS OWN SCHEMA (`export_files`, tenant migration
// 0036); a platform report's in `platform_export_files`. This module is the ONLY writer of both.
//
// A background build runs after the request has answered. If the process dies first the row is
// left PENDING; the scheduler's `export-cleanup` job closes such a row FAILED ("interrupted") and
// expires READY files past their time, removing the ciphertext — so a failed export never
// silently disappears and a file never outlives its window.
// ===========================================================================

import { createHash } from "node:crypto";
import { platformDb } from "../../db/platform";
import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import { decryptBytes, encryptBytes } from "../../lib/crypto/credential-cipher";
import { recordAudit } from "../identity/audit";
import { writeCsv } from "./csv";
import type { AppliedFilter, ReportDocument } from "./model";
import { rowCount } from "./model";
import { writePdf } from "./pdf";
import { exportFilename } from "./values";
import { writeXlsx } from "./xlsx";

export type ExportFormat = "xlsx" | "csv" | "pdf";
export const EXPORT_FORMATS: readonly ExportFormat[] = ["xlsx", "csv", "pdf"];

const CONTENT_TYPE: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
};

/** Above this many rows an export is built in the background. */
export function syncMaxRows(): number {
  const raw = process.env.EXPORT_SYNC_MAX_ROWS;
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 5_000;
}
/** How long a background export may be downloaded. */
export const EXPORT_TTL_MINUTES = 30;
/** A PENDING build older than this was interrupted. */
export const EXPORT_STALE_MINUTES = 30;

export interface RenderedExport {
  body: Buffer;
  contentType: string;
  filename: string;
}

export async function renderExport(document: ReportDocument, format: ExportFormat): Promise<RenderedExport> {
  const body = format === "xlsx" ? await writeXlsx(document) : format === "pdf" ? await writePdf(document) : writeCsv(document);
  return { body, contentType: CONTENT_TYPE[format], filename: exportFilename(document.brand.name, document.reportId, document.period, document.generatedAt, format) };
}

export class ExportNotFoundError extends Error {
  constructor() {
    super("No such export.");
    this.name = "ExportNotFoundError";
  }
}

export class ExportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportUnavailableError";
  }
}

/** Where export files are kept: a business's own schema, or the platform's table. */
export type ExportStore = { kind: "tenant"; db: TenantPrismaClient; tenantId: string } | { kind: "platform" };

export interface ExportView {
  id: string;
  reportId: string;
  format: string;
  status: string;
  rowCount: number;
  filename: string | null;
  byteSize: number | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  expiresAt: Date;
}

const VIEW_SELECT = { id: true, reportId: true, format: true, status: true, rowCount: true, filename: true, byteSize: true, error: true, createdAt: true, finishedAt: true, expiresAt: true } as const;

interface Request {
  reportId: string;
  format: ExportFormat;
  filters: readonly AppliedFilter[];
  sensitive: boolean;
  actorUserId: string;
  ipAddress: string | null;
}

async function audit(store: ExportStore, action: "REPORT_EXPORTED" | "REPORT_EXPORT_DOWNLOADED", request: Pick<Request, "reportId" | "actorUserId" | "ipAddress"> & { format: string; rows: number; mode: string; sensitive: boolean; filters?: string }): Promise<void> {
  await recordAudit(platformDb, {
    action,
    actorUserId: request.actorUserId,
    targetUserId: null,
    tenantId: store.kind === "tenant" ? store.tenantId : null,
    ipAddress: request.ipAddress,
    metadata: {
      reportId: request.reportId,
      format: request.format,
      rows: request.rows,
      mode: request.mode,
      sensitive: request.sensitive,
      ...(request.filters !== undefined ? { filters: request.filters.slice(0, 900) } : {}),
    },
  });
}

const filtersText = (filters: readonly AppliedFilter[]) => filters.map((f) => `${f.label}: ${f.value}`).join("; ");

export type ExportOutcome = { mode: "stream"; file: RenderedExport } | { mode: "background"; export: ExportView };

/**
 * Exports a document: streamed when small, otherwise built in the background. The document is
 * built ONCE, by the caller, from the same filters the screen used.
 */
export async function exportDocument(store: ExportStore, document: ReportDocument, request: Request): Promise<ExportOutcome> {
  const rows = rowCount(document);
  if (rows <= syncMaxRows()) {
    const file = await renderExport(document, request.format);
    await audit(store, "REPORT_EXPORTED", { ...request, rows, mode: "stream", filters: filtersText(request.filters) });
    return { mode: "stream", file };
  }
  const created = await createRow(store, request, rows);
  await audit(store, "REPORT_EXPORTED", { ...request, rows, mode: "background", filters: filtersText(request.filters) });
  setImmediate(() => {
    void build(store, created.id, document, request.format);
  });
  return { mode: "background", export: created };
}

async function createRow(store: ExportStore, request: Request, rows: number): Promise<ExportView> {
  const data = {
    reportId: request.reportId,
    format: request.format,
    filters: request.filters.map((f) => ({ label: f.label, value: f.value })),
    rowCount: rows,
    requestedBy: request.actorUserId,
    expiresAt: new Date(Date.now() + (EXPORT_STALE_MINUTES + EXPORT_TTL_MINUTES) * 60_000),
  };
  return store.kind === "tenant"
    ? store.db.exportFile.create({ data, select: VIEW_SELECT })
    : platformDb.platformExportFile.create({ data, select: VIEW_SELECT });
}

/** Builds a PENDING export into an encrypted file; a failure is recorded, never thrown away. */
export async function build(store: ExportStore, id: string, document: ReportDocument, format: ExportFormat): Promise<void> {
  try {
    const file = await renderExport(document, format);
    const blob = encryptBytes(file.body);
    const data = {
      status: "READY",
      filename: file.filename,
      contentType: file.contentType,
      byteSize: file.body.length,
      sha256: createHash("sha256").update(file.body).digest("hex"),
      ...blob,
      finishedAt: new Date(),
      expiresAt: new Date(Date.now() + EXPORT_TTL_MINUTES * 60_000),
    };
    if (store.kind === "tenant") await store.db.exportFile.updateMany({ where: { id, status: "PENDING" }, data });
    else await platformDb.platformExportFile.updateMany({ where: { id, status: "PENDING" }, data });
  } catch (error) {
    const data = { status: "FAILED", error: `The export could not be built (${error instanceof Error ? error.name : "unknown error"}).`, finishedAt: new Date() };
    if (store.kind === "tenant") await store.db.exportFile.updateMany({ where: { id, status: "PENDING" }, data });
    else await platformDb.platformExportFile.updateMany({ where: { id, status: "PENDING" }, data });
  }
}

/** The requester's own export — anyone else's is not found. */
export async function getExport(store: ExportStore, id: string, userId: string): Promise<ExportView> {
  const row =
    store.kind === "tenant"
      ? await store.db.exportFile.findFirst({ where: { id, requestedBy: userId }, select: VIEW_SELECT })
      : await platformDb.platformExportFile.findFirst({ where: { id, requestedBy: userId }, select: VIEW_SELECT });
  if (row === null) throw new ExportNotFoundError();
  return row;
}

export async function listExports(store: ExportStore, userId: string): Promise<ExportView[]> {
  const where = { requestedBy: userId };
  const orderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  return store.kind === "tenant"
    ? store.db.exportFile.findMany({ where, orderBy, take: 50, select: VIEW_SELECT })
    : platformDb.platformExportFile.findMany({ where, orderBy, take: 50, select: VIEW_SELECT });
}

/** The requester's READY, unexpired file, decrypted and integrity-checked. Audited. */
export async function downloadExport(store: ExportStore, id: string, userId: string, ipAddress: string | null, now: Date = new Date()): Promise<RenderedExport> {
  const select = { ...VIEW_SELECT, contentType: true, sha256: true, ciphertext: true, iv: true, authTag: true, keyRef: true } as const;
  const row =
    store.kind === "tenant"
      ? await store.db.exportFile.findFirst({ where: { id, requestedBy: userId }, select })
      : await platformDb.platformExportFile.findFirst({ where: { id, requestedBy: userId }, select });
  if (row === null) throw new ExportNotFoundError();
  if (row.status === "PENDING") throw new ExportUnavailableError("This export is still being prepared. Try again in a moment.");
  if (row.status === "FAILED") throw new ExportUnavailableError(row.error ?? "This export failed. Run it again.");
  if (row.status !== "READY" || row.expiresAt <= now || row.ciphertext === null || row.iv === null || row.authTag === null || row.keyRef === null) {
    throw new ExportUnavailableError("This export has expired. Run it again to get a fresh file.");
  }
  const body = decryptBytes({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag, keyRef: row.keyRef });
  if (createHash("sha256").update(body).digest("hex") !== row.sha256) throw new ExportUnavailableError("This export failed its integrity check. Run it again.");
  await audit(store, "REPORT_EXPORT_DOWNLOADED", { reportId: row.reportId, actorUserId: userId, ipAddress, format: row.format, rows: row.rowCount, mode: "background", sensitive: true });
  return { body, contentType: row.contentType ?? CONTENT_TYPE.csv, filename: row.filename ?? `${row.reportId}.${row.format}` };
}

/**
 * THE CLEANUP (the scheduler's `export-cleanup` job): READY files past their window become
 * EXPIRED with their ciphertext removed; PENDING builds older than the stale limit become FAILED
 * ("interrupted"). Idempotent — a second run finds nothing to do. Returns what it changed.
 */
export async function cleanupExports(store: ExportStore, now: Date = new Date()): Promise<{ expired: number; interrupted: number }> {
  const expire = { status: "EXPIRED", ciphertext: null, iv: null, authTag: null, keyRef: null };
  const stale = new Date(now.getTime() - EXPORT_STALE_MINUTES * 60_000);
  const interrupt = { status: "FAILED", error: "The export was interrupted before it finished. Run it again.", finishedAt: now };
  if (store.kind === "tenant") {
    const expired = await store.db.exportFile.updateMany({ where: { status: "READY", expiresAt: { lte: now } }, data: expire });
    const interrupted = await store.db.exportFile.updateMany({ where: { status: "PENDING", createdAt: { lte: stale } }, data: interrupt });
    return { expired: expired.count, interrupted: interrupted.count };
  }
  const expired = await platformDb.platformExportFile.updateMany({ where: { status: "READY", expiresAt: { lte: now } }, data: expire });
  const interrupted = await platformDb.platformExportFile.updateMany({ where: { status: "PENDING", createdAt: { lte: stale } }, data: interrupt });
  return { expired: expired.count, interrupted: interrupted.count };
}
