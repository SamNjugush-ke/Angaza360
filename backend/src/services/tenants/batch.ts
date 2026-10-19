// ===========================================================================
// Batch CSV onboarding (Task T-A6.3) — onboarding's use of the CSV import framework
// (src/services/csv/import.ts): VALIDATE the file -> PREVIEW every row -> COMMIT.
//
// UPLOAD validates the FILE (header, columns, row count) and stores one OnboardingBatch
// (PREVIEW) plus one TenantApplication per data row (source BATCH, batchId,
// batchRowNumber). NOTHING IS PROVISIONED.
//
// PREVIEW runs the green-gate over every remaining row, INCLUDING within-file dedup: each
// row is compared with its siblings (two rows sharing a business name, KRA PIN, National
// ID, owner email or subdomain are BOTH flagged) as well as with tenants and other open
// applications. Proposed subdomains are assigned in row order, never colliding with a
// sibling's. The answer carries every row's GREEN / errors and an "all green?" flag.
//
// A row is corrected (PATCH, re-validated) or removed (DELETE) while its batch is PREVIEW.
//
// COMMIT IS THE BATCH GREEN-GATE: it re-runs the preview and REFUSES unless EVERY remaining
// row is GREEN. Then each row is provisioned through the one path (provisionGreenCandidate)
// and recorded APPROVED with its tenant; the batch becomes COMMITTED. It is IDEMPOTENT:
// only PENDING rows are ever provisioned, so a commit interrupted part-way resumes where it
// stopped, and a COMMITTED batch provisions nothing new. SUPER_ADMIN only.
// ===========================================================================

import { platformDb } from "../../db/platform";
import { csvTemplate, readCsv, type CsvSchema } from "../csv/import";
import { recordAudit } from "../identity/audit";
import type { Actor } from "../identity/user-management";
import { APPLICATION_SELECT, applicationCandidate, billingSeam, candidateColumns, type ApplicationView } from "./applications";
import {
  normalizeCandidate,
  validateOnboardingCandidate,
  type CandidateError,
  type NormalizedCandidate,
  type OnboardingCandidate,
} from "./candidate";
import { assertMayProvision, provisionGreenCandidate, type OnboardedTenant } from "./onboarding";
import { TenantAdminError } from "./tenant-view";

/** The onboarding CSV: the template a user downloads is generated from this. */
export const ONBOARDING_CSV_SCHEMA: CsvSchema = {
  maxRows: 500,
  columns: [
    { name: "businessName", required: true, description: "Registered business name; unique." },
    { name: "subdomain", required: false, description: "Optional; generated from the name when blank." },
    { name: "sector", required: false, description: "e.g. Retail, Hardware, Agrovet." },
    { name: "kraPin", required: false, description: "The business KRA PIN, e.g. P051234567X; unique." },
    { name: "taxRegime", required: true, description: "VAT_REGISTERED, TURNOVER_TAX or EXEMPT." },
    { name: "requestedTier", required: false, description: "MWANZO, UKUAJI, BIASHARA, MSTAWI or ENTERPRISE." },
    { name: "ownerFullName", required: true, description: "The first owner's full name." },
    { name: "ownerEmail", required: true, description: "The owner's email; the invitation goes here." },
    { name: "ownerPhone", required: false, description: "The owner's phone; the invitation also goes by SMS." },
    { name: "ownerNationalId", required: false, description: "The owner's National ID; unique." },
  ],
};

export function onboardingCsvTemplate(): string {
  return csvTemplate(ONBOARDING_CSV_SCHEMA);
}

export interface BatchView {
  readonly id: string;
  readonly uploadedById: string;
  readonly status: "PREVIEW" | "COMMITTED";
  readonly createdAt: Date;
  readonly committedAt: Date | null;
}

export interface PreviewRow {
  readonly application: ApplicationView;
  readonly status: "GREEN" | "RED";
  readonly errors: CandidateError[];
  readonly proposedSubdomain: string | null;
}

export interface BatchPreview {
  readonly batch: BatchView;
  readonly rows: PreviewRow[];
  readonly allGreen: boolean;
}

const BATCH_SELECT = { id: true, uploadedById: true, status: true, createdAt: true, committedAt: true } as const;

async function loadBatch(batchId: string): Promise<BatchView> {
  const batch = await platformDb.onboardingBatch.findUnique({ where: { id: batchId }, select: BATCH_SELECT });
  if (batch === null) {
    throw new TenantAdminError(404, "No such batch.");
  }
  return batch;
}

function cell(values: Readonly<Record<string, string>>, name: string): string {
  return values[name] ?? "";
}

// ---- Upload -----------------------------------------------------------------------

export async function uploadBatch(actor: Actor, csv: string): Promise<BatchPreview> {
  const rows = readCsv(ONBOARDING_CSV_SCHEMA, csv);
  const batch = await platformDb.$transaction(async (tx) => {
    const created = await tx.onboardingBatch.create({ data: { uploadedById: actor.userId }, select: BATCH_SELECT });
    for (const row of rows) {
      const c = normalizeCandidate({
        businessName: cell(row.values, "businessName"),
        subdomain: cell(row.values, "subdomain"),
        sector: cell(row.values, "sector"),
        kraPin: cell(row.values, "kraPin"),
        taxRegime: cell(row.values, "taxRegime"),
        requestedTier: cell(row.values, "requestedTier"),
        ownerFullName: cell(row.values, "ownerFullName"),
        ownerEmail: cell(row.values, "ownerEmail"),
        ownerPhone: cell(row.values, "ownerPhone"),
        ownerNationalId: cell(row.values, "ownerNationalId"),
      });
      await tx.tenantApplication.create({
        data: { ...candidateColumns(c, c.subdomain), source: "BATCH", batchId: created.id, batchRowNumber: row.rowNumber },
      });
    }
    await recordAudit(tx, {
      action: "BATCH_UPLOADED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: null,
      ipAddress: actor.ipAddress,
      metadata: { batchId: created.id, rows: rows.length },
    });
    return created;
  });
  return previewBatch(batch.id);
}

// ---- Preview -----------------------------------------------------------------------

async function pendingRows(batchId: string): Promise<ApplicationView[]> {
  return platformDb.tenantApplication.findMany({
    where: { batchId, status: "PENDING_APPROVAL" },
    orderBy: [{ batchRowNumber: "asc" }],
    select: APPLICATION_SELECT,
  });
}

/** The green-gate over every pending row, with within-file dedup and sibling-safe subdomains. */
async function evaluate(batchId: string, rows: readonly ApplicationView[]): Promise<PreviewRow[]> {
  const candidates: OnboardingCandidate[] = rows.map(applicationCandidate);
  const normalized: NormalizedCandidate[] = candidates.map(normalizeCandidate);
  const claimed = new Set<string>();
  const result: PreviewRow[] = [];
  for (const [index, row] of rows.entries()) {
    const siblings = normalized.filter((_, other) => other !== index);
    const siblingSubdomains = new Set<string>(claimed);
    for (const [other, sibling] of normalized.entries()) {
      if (other !== index && sibling.subdomain !== null) siblingSubdomains.add(sibling.subdomain);
    }
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const validation = await validateOnboardingCandidate(candidate, {
      siblings,
      siblingSubdomains,
      excludeApplicationId: row.id,
      excludeBatchId: batchId,
    });
    if (validation.proposedSubdomain !== null) claimed.add(validation.proposedSubdomain);
    result.push({ application: row, status: validation.status, errors: [...validation.errors], proposedSubdomain: validation.proposedSubdomain });
  }
  return result;
}

export async function previewBatch(batchId: string): Promise<BatchPreview> {
  const batch = await loadBatch(batchId);
  if (batch.status === "COMMITTED") {
    const decided = await platformDb.tenantApplication.findMany({
      where: { batchId },
      orderBy: [{ batchRowNumber: "asc" }],
      select: APPLICATION_SELECT,
    });
    return {
      batch,
      rows: decided.map((application) => ({ application, status: "GREEN", errors: [], proposedSubdomain: application.proposedSubdomain })),
      allGreen: true,
    };
  }
  const rows = await evaluate(batchId, await pendingRows(batchId));
  return { batch, rows, allGreen: rows.length > 0 && rows.every((row) => row.status === "GREEN") };
}

// ---- Correct / remove a row ---------------------------------------------------------

async function editableRow(applicationId: string): Promise<ApplicationView> {
  const row = await platformDb.tenantApplication.findUnique({ where: { id: applicationId }, select: APPLICATION_SELECT });
  if (row === null) {
    throw new TenantAdminError(404, "No such application.");
  }
  if (row.source !== "BATCH" || row.batchId === null) {
    throw new TenantAdminError(409, "Only a batch row is edited or removed here; a self-serve application is approved or rejected.");
  }
  if (row.status !== "PENDING_APPROVAL" || (await loadBatch(row.batchId)).status !== "PREVIEW") {
    throw new TenantAdminError(409, "The batch has been committed; its rows are final.");
  }
  return row;
}

export type RowEdit = Partial<Omit<OnboardingCandidate, "taxRegime">> & { readonly taxRegime?: string };

export async function editBatchRow(applicationId: string, edit: RowEdit): Promise<PreviewRow> {
  const row = await editableRow(applicationId);
  const merged = normalizeCandidate({ ...applicationCandidate(row), ...edit });
  await platformDb.tenantApplication.update({ where: { id: row.id }, data: candidateColumns(merged, merged.subdomain) });
  const preview = await previewBatch(row.batchId ?? "");
  const updated = preview.rows.find((entry) => entry.application.id === row.id);
  if (updated === undefined) {
    throw new TenantAdminError(404, "No such application.");
  }
  return updated;
}

export async function removeBatchRow(applicationId: string): Promise<void> {
  const row = await editableRow(applicationId);
  await platformDb.tenantApplication.delete({ where: { id: row.id } });
}

// ---- Commit --------------------------------------------------------------------------

export interface BatchCommit {
  readonly batch: BatchView;
  /** True when the batch was already COMMITTED: nothing new was provisioned. */
  readonly alreadyCommitted: boolean;
  readonly onboarded: OnboardedTenant[];
}

export async function commitBatch(actor: Actor, batchId: string): Promise<BatchCommit> {
  assertMayProvision(actor);
  const batch = await loadBatch(batchId);
  if (batch.status === "COMMITTED") {
    return { batch, alreadyCommitted: true, onboarded: [] };
  }

  // THE BATCH GREEN-GATE: every remaining row, re-validated now, must be GREEN.
  const rows = await evaluate(batchId, await pendingRows(batchId));
  const red = rows.filter((row) => row.status !== "GREEN");
  if (red.length > 0) {
    throw new TenantAdminError(
      409,
      `The batch cannot be committed while any row is not green: ${red
        .map((row) => `row ${(row.application.batchRowNumber ?? 0).toString()} (${row.errors.map((e) => e.field).join(", ")})`)
        .join("; ")}.`,
    );
  }
  const approvedEarlier = await platformDb.tenantApplication.count({ where: { batchId, status: "APPROVED" } });
  if (rows.length === 0 && approvedEarlier === 0) {
    throw new TenantAdminError(409, "The batch has no rows to commit.");
  }

  const onboarded: OnboardedTenant[] = [];
  for (const row of rows) {
    const subdomain = row.proposedSubdomain;
    if (subdomain === null) {
      throw new TenantAdminError(409, `Row ${(row.application.batchRowNumber ?? 0).toString()} has no subdomain.`);
    }
    const candidate = billingSeam(normalizeCandidate(applicationCandidate(row.application)));
    const result = await provisionGreenCandidate(actor, candidate, subdomain, "BATCH", { batchId, applicationId: row.application.id });
    await platformDb.$transaction(async (tx) => {
      await tx.tenantApplication.update({
        where: { id: row.application.id },
        data: { status: "APPROVED", proposedSubdomain: subdomain, reviewedById: actor.userId, reviewedAt: new Date(), resultingTenantId: result.tenant.id },
      });
      await recordAudit(tx, {
        action: "APPLICATION_APPROVED",
        actorUserId: actor.userId,
        targetUserId: null,
        tenantId: result.tenant.id,
        ipAddress: actor.ipAddress,
        metadata: { applicationId: row.application.id, batchId, subdomain },
      });
    });
    onboarded.push(result);
  }

  const committed = await platformDb.$transaction(async (tx) => {
    const updated = await tx.onboardingBatch.update({
      where: { id: batchId },
      data: { status: "COMMITTED", committedAt: new Date() },
      select: BATCH_SELECT,
    });
    await recordAudit(tx, {
      action: "BATCH_COMMITTED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: null,
      ipAddress: actor.ipAddress,
      metadata: { batchId, onboarded: onboarded.length, approvedEarlier },
    });
    return updated;
  });
  return { batch: committed, alreadyCommitted: false, onboarded };
}
