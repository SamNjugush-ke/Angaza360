// ===========================================================================
// The owner's ID document (M4.5 Wave 2) — DPA-secure handling, end to end.
//
// ACCEPT ONLY WHAT IT CLAIMS TO BE. An upload is judged by its CONTENT, never its filename:
// the first bytes must be a JPEG, PNG or PDF signature, agree with the declared type, and the
// file must be structurally whole (a JPEG ends FFD9, a PNG has its IEND chunk, a PDF its
// %%EOF), between MIN_BYTES and MAX_BYTES. The CONTENT GUARD then refuses what an ID scan never
// contains: a PDF with active content (JavaScript, launch actions, embedded files, auto-open
// actions) and any file carrying script or server-page markers (a polyglot). This is a guard,
// not an antivirus engine — see the tracked item in the engineering ledger.
//
// STORED PRIVATELY AND ENCRYPTED. The bytes are encrypted with the integration-credential
// cipher (AES-256-GCM, keyRef seam) and live ONLY in public.application_documents — never on
// disk, never under any served path, so there is no URL that could expose one. The table
// keeps a sha256 of the plaintext for integrity.
//
// SEEN ONLY BY WHO MUST SEE IT. A SUPER_ADMIN, or the platform officer who opened the review,
// asks for a VIEW GRANT: single-use, valid VIEW_GRANT_SECONDS, bound to that person, stored as
// sha256. Redeeming it returns the bytes once. Both the grant and the view are audited
// (APPLICATION_DOCUMENT_VIEWED). Every other role — another programme officer, a mentor, any
// business user — is refused, and no ordinary response, export or log line ever carries a
// document: application views carry only the side, type, size and upload time.
//
// RETENTION: a document is purged (ciphertext removed, a stub kept recording when)
// RETAIN_AFTER_DECISION_DAYS after the application is APPROVED or REJECTED, and an abandoned
// DRAFT's after RETAIN_DRAFT_DAYS — `purgeExpiredDocuments`, run by `applications:purge-documents`.
// ===========================================================================

import { createHash } from "node:crypto";
import { platformDb } from "../../db/platform";
import { decryptBytes, encryptBytes } from "../../lib/crypto/credential-cipher";
import { recordAudit, type PlatformTx } from "../identity/audit";
import type { Actor } from "../identity/user-management";
import { hashSecretToken, issueSecretToken } from "../identity/secret-token";
import { TenantAdminError } from "./tenant-view";

export const MIN_BYTES = 1024;
export const MAX_BYTES = 5 * 1024 * 1024;
export const VIEW_GRANT_SECONDS = 120;
export const RETAIN_AFTER_DECISION_DAYS = 180;
export const RETAIN_DRAFT_DAYS = 30;

export type DocumentSide = "FRONT" | "BACK";
export type DocumentContentType = "image/jpeg" | "image/png" | "application/pdf";
export const DOCUMENT_CONTENT_TYPES: readonly DocumentContentType[] = ["image/jpeg", "image/png", "application/pdf"];

export class DocumentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentRejectedError";
  }
}

const startsWith = (bytes: Buffer, signature: readonly number[]) =>
  bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);

/** What the bytes ARE, by their signature — or null. Never the filename. */
export function sniffContentType(bytes: Buffer): DocumentContentType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return null;
}

function structurallyWhole(bytes: Buffer, type: DocumentContentType): boolean {
  if (type === "image/jpeg") {
    // The end-of-image marker, allowing trailing padding.
    const tail = bytes.subarray(Math.max(0, bytes.length - 64));
    return tail.includes(Buffer.from([0xff, 0xd9]));
  }
  if (type === "image/png") {
    return bytes.subarray(Math.max(0, bytes.length - 64)).includes(Buffer.from("IEND", "latin1"));
  }
  return bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from("%%EOF", "latin1"));
}

// Markers an ID scan never contains: PDF active content, and script / server-page payloads
// smuggled into an image or PDF (a polyglot).
const PDF_ACTIVE_CONTENT = [/\/JavaScript\b/, /\/JS\b/, /\/Launch\b/, /\/EmbeddedFile\b/, /\/OpenAction\b/, /\/AA\b/, /\/RichMedia\b/, /\/XFA\b/];
const POLYGLOT_MARKERS = [/<script/i, /<\?php/i, /<%[=@]?/, /<html/i, /<svg/i, /javascript:/i];

/**
 * Validates an upload BY CONTENT and returns its true type. Throws DocumentRejectedError with a
 * reason the applicant can act on.
 */
export function validateDocumentUpload(bytes: Buffer, declaredType: string | null): DocumentContentType {
  if (bytes.length < MIN_BYTES) {
    throw new DocumentRejectedError("The file is too small to be a readable scan. Upload a clear photo or scan of the ID.");
  }
  if (bytes.length > MAX_BYTES) {
    throw new DocumentRejectedError(`The file is larger than ${(MAX_BYTES / 1024 / 1024).toString()} MB. Upload a smaller photo or scan.`);
  }
  const type = sniffContentType(bytes);
  if (type === null) {
    throw new DocumentRejectedError("Only a JPG, PNG or PDF file is accepted — this file is none of them, whatever its name says.");
  }
  if (declaredType !== null && declaredType.split(";")[0]?.trim().toLowerCase() !== type) {
    throw new DocumentRejectedError("The file's content does not match its declared type.");
  }
  if (!structurallyWhole(bytes, type)) {
    throw new DocumentRejectedError("The file is incomplete or damaged. Upload it again.");
  }
  const text = bytes.toString("latin1");
  if (type === "application/pdf" && PDF_ACTIVE_CONTENT.some((pattern) => pattern.test(text))) {
    throw new DocumentRejectedError("The PDF contains active content (scripts, actions or attachments) and cannot be accepted. Upload a plain scan or photo.");
  }
  // Scanned only in a PDF, which is text-structured: compressed JPEG / PNG bytes produce these
  // sequences by chance (e.g. "<%"), which refused real ID photos. An image is served back
  // inline only under no-store, nosniff and a sandbox CSP, so its bytes are never run as markup.
  if (type === "application/pdf" && POLYGLOT_MARKERS.some((pattern) => pattern.test(text))) {
    throw new DocumentRejectedError("The file contains content that an ID scan never does, and cannot be accepted.");
  }
  return type;
}

export interface DocumentMeta {
  readonly id: string;
  readonly side: DocumentSide;
  readonly contentType: string;
  readonly byteSize: number;
  readonly uploadedAt: Date;
  readonly purgedAt: Date | null;
}

/** The ONLY shape a document takes in an ordinary response: no bytes, no hash, no cipher parts. */
export const DOCUMENT_META_SELECT = { id: true, side: true, contentType: true, byteSize: true, uploadedAt: true, purgedAt: true } as const;

export async function documentMeta(applicationId: string): Promise<DocumentMeta[]> {
  const rows = await platformDb.applicationDocument.findMany({
    where: { applicationId },
    orderBy: [{ uploadedAt: "asc" }],
    select: DOCUMENT_META_SELECT,
  });
  return rows.map((row) => ({ ...row, side: row.side as DocumentSide }));
}

/**
 * Stores (or replaces) one side of the owner's ID, encrypted. The caller has established that
 * the applicant may edit (DRAFT / NEEDS_CHANGES); the database refuses otherwise.
 */
export async function storeDocument(
  tx: PlatformTx,
  applicationId: string,
  side: DocumentSide,
  bytes: Buffer,
  declaredType: string | null,
): Promise<DocumentMeta> {
  const contentType = validateDocumentUpload(bytes, declaredType);
  const blob = encryptBytes(bytes);
  await tx.applicationDocument.deleteMany({ where: { applicationId, side, purgedAt: null } });
  const row = await tx.applicationDocument.create({
    data: {
      applicationId,
      kind: "NATIONAL_ID",
      side,
      contentType,
      byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ciphertext: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
      keyRef: blob.keyRef,
    },
    select: DOCUMENT_META_SELECT,
  });
  return { ...row, side: row.side as DocumentSide };
}

// ---- Authorised viewing ----------------------------------------------------------

/** SUPER_ADMIN, or the officer reviewing THIS application. Nobody else, ever. */
async function assertMayView(actor: Actor, applicationId: string): Promise<void> {
  if (actor.role === "SUPER_ADMIN") return;
  if (actor.role === "PROGRAM_OFFICER") {
    const app = await platformDb.tenantApplication.findUnique({ where: { id: applicationId }, select: { reviewerUserId: true } });
    if (app?.reviewerUserId === actor.userId) return;
  }
  throw new TenantAdminError(403, "Only a SUPER_ADMIN or the officer reviewing this application may view its ID document.");
}

export interface ViewGrant {
  readonly token: string;
  readonly expiresAt: Date;
}

export async function issueDocumentView(actor: Actor, applicationId: string, documentId: string): Promise<ViewGrant> {
  await assertMayView(actor, applicationId);
  const document = await platformDb.applicationDocument.findFirst({ where: { id: documentId, applicationId }, select: { id: true, side: true, purgedAt: true } });
  if (document === null) {
    throw new TenantAdminError(404, "No such document on this application.");
  }
  if (document.purgedAt !== null) {
    throw new TenantAdminError(409, "This document was deleted under the retention schedule.");
  }
  const token = issueSecretToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + VIEW_GRANT_SECONDS * 1000);
  await platformDb.$transaction(async (tx) => {
    await tx.applicationDocumentView.create({ data: { documentId, userId: actor.userId, tokenHash: token.hash, createdAt: now, expiresAt } });
    await recordAudit(tx, {
      action: "APPLICATION_DOCUMENT_VIEWED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: null,
      ipAddress: actor.ipAddress,
      metadata: { applicationId, documentId, side: document.side, step: "grant" },
    });
  });
  return { token: token.raw, expiresAt };
}

export interface DocumentBytes {
  readonly bytes: Buffer;
  readonly contentType: string;
}

/** Redeems a view grant ONCE, for the user it was issued to; anything else is the one 404. */
export async function redeemDocumentView(actor: Actor, rawToken: string): Promise<DocumentBytes> {
  const tokenHash = hashSecretToken(rawToken);
  return platformDb.$transaction(async (tx) => {
    const grant = await tx.applicationDocumentView.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, usedAt: true, expiresAt: true, document: { select: { id: true, applicationId: true, side: true, contentType: true, ciphertext: true, iv: true, authTag: true, keyRef: true, sha256: true } } },
    });
    if (grant === null || grant.userId !== actor.userId || grant.usedAt !== null || grant.expiresAt.getTime() <= Date.now()) {
      throw new TenantAdminError(404, "This view link is not valid. Ask for a new one.");
    }
    const doc = grant.document;
    if (doc.ciphertext === null || doc.iv === null || doc.authTag === null || doc.keyRef === null) {
      throw new TenantAdminError(409, "This document was deleted under the retention schedule.");
    }
    const used = await tx.applicationDocumentView.updateMany({ where: { id: grant.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) {
      throw new TenantAdminError(404, "This view link is not valid. Ask for a new one.");
    }
    const bytes = decryptBytes({ ciphertext: doc.ciphertext, iv: doc.iv, authTag: doc.authTag, keyRef: doc.keyRef });
    if (createHash("sha256").update(bytes).digest("hex") !== doc.sha256) {
      throw new Error("An application document failed its integrity check.");
    }
    await recordAudit(tx, {
      action: "APPLICATION_DOCUMENT_VIEWED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: null,
      ipAddress: actor.ipAddress,
      metadata: { applicationId: doc.applicationId, documentId: doc.id, side: doc.side, step: "view" },
    });
    return { bytes, contentType: doc.contentType };
  });
}

// ---- Retention -------------------------------------------------------------------

export interface PurgeReport {
  readonly purged: number;
  readonly applications: number;
}

/**
 * The retention schedule: purge the ID documents of applications decided more than
 * RETAIN_AFTER_DECISION_DAYS ago, and of DRAFTS untouched for RETAIN_DRAFT_DAYS. The
 * ciphertext is removed; a stub records that the document existed and when it was purged.
 * Idempotent.
 */
export async function purgeExpiredDocuments(now: Date = new Date(), options: { dryRun?: boolean } = {}): Promise<PurgeReport> {
  const decidedBefore = new Date(now.getTime() - RETAIN_AFTER_DECISION_DAYS * 86_400_000);
  const draftBefore = new Date(now.getTime() - RETAIN_DRAFT_DAYS * 86_400_000);
  const due = await platformDb.applicationDocument.findMany({
    where: {
      purgedAt: null,
      application: {
        OR: [
          { status: { in: ["APPROVED", "REJECTED"] }, reviewedAt: { lt: decidedBefore } },
          { status: "DRAFT", updatedAt: { lt: draftBefore } },
        ],
      },
    },
    select: { id: true, applicationId: true },
  });
  const applications = new Set(due.map((doc) => doc.applicationId));
  if (options.dryRun === true || due.length === 0) {
    return { purged: due.length, applications: applications.size };
  }
  await platformDb.$transaction(async (tx) => {
    await tx.applicationDocument.updateMany({
      where: { id: { in: due.map((doc) => doc.id) }, purgedAt: null },
      data: { purgedAt: now, ciphertext: null, iv: null, authTag: null, keyRef: null },
    });
    for (const applicationId of applications) {
      const app = await tx.tenantApplication.findUnique({ where: { id: applicationId }, select: { status: true } });
      if (app !== null && app.status !== "DRAFT") {
        await tx.tenantApplicationEvent.create({ data: { applicationId, kind: "DOCUMENTS_PURGED", message: "The ID document was deleted under the retention schedule." } });
      }
      await recordAudit(tx, {
        action: "APPLICATION_DOCUMENTS_PURGED",
        actorUserId: null,
        targetUserId: null,
        tenantId: null,
        ipAddress: null,
        metadata: { applicationId },
      });
    }
  });
  return { purged: due.length, applications: applications.size };
}
