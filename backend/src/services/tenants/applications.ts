// ===========================================================================
// Tenant applications: the public application, its review, and the applicant's view
// (Task T-A6.2; rebuilt for M4.5 Wave 2).
//
// THE STATE MACHINE (held by tenant_application_guard; see the platform migration
// 20261116110000):
//
//   DRAFT ──submit──▶ SUBMITTED ──startReview──▶ UNDER_REVIEW ──approve──▶ APPROVED
//     ▲                                            │  │  └──reject──▶ REJECTED
//     │                                            │  └─requestChanges─▶ NEEDS_CHANGES
//     └────────── (applicant edits) ◀──────────────┘          │
//                                     resubmit ◀──────────────┘  (NEEDS_CHANGES -> SUBMITTED)
//
// A batch row (T-A6.3) is born SUBMITTED and goes straight to APPROVED at its batch's commit.
//
// THE APPLICANT holds a bearer secret — the application ACCESS TOKEN (sha256 only; a fresh one
// in every notification) — which opens their status page and, while DRAFT or NEEDS_CHANGES, lets
// them edit, upload the ID document and submit. Nothing about an application is reachable
// without it, and an unknown token is the one generic 404.
//
// WHAT AN ANONYMOUS CALLER MAY LEARN is limited (enumeration safety, unchanged): a missing or
// malformed field and a business NAME already registered are public facts ("pick another"); a
// duplicate KRA PIN, owner National ID or owner email is NEVER revealed — the application is
// accepted like any other, the reviewer sees the clash (the queue re-runs the green-gate), and
// approval refuses it. So no second active business is ever created, and nobody learns who is
// registered. A DRAFT reserves nothing; a REJECTED application reserves nothing either.
//
// THE REVIEWER corrects ADMINISTRATIVE details only (MINOR_FIELDS), each correction recorded on
// the applicant-visible timeline and audited; IDENTITY AND OWNERSHIP (SUBSTANTIVE) are never
// changed behind the applicant — the database refuses it — and go back to them as a request for
// changes, so they re-confirm by resubmitting.
//
// APPROVE re-runs the green-gate AT APPROVAL TIME and provisions through the one path
// (provisionGreenCandidate), after THE BILLING SEAM.
// ===========================================================================

import { env } from "../../config/env";
import { platformDb } from "../../db/platform";
import type { TenantApplicationSource, TenantApplicationStatus } from "../../generated/platform/enums";
import { recordAudit, type PlatformTx } from "../identity/audit";
import type { Actor } from "../identity/user-management";
import { hashSecretToken, issueSecretToken } from "../identity/secret-token";
import { sendNotification } from "../notifications/notification-service";
import {
  validateOnboardingCandidate,
  type CandidateError,
  type CandidateValidation,
  type NormalizedCandidate,
  type OnboardingCandidate,
} from "./candidate";
import { documentMeta, storeDocument, type DocumentMeta, type DocumentSide } from "./documents";
import { assertMayProvision, provisionGreenCandidate, type OnboardedTenant } from "./onboarding";
import { TenantAdminError } from "./tenant-view";

export interface ApplicationView {
  readonly id: string;
  readonly businessName: string;
  readonly proposedSubdomain: string | null;
  readonly sector: string | null;
  readonly kraPin: string | null;
  readonly taxRegime: string;
  readonly requestedTier: string | null;
  readonly ownerFullName: string;
  readonly ownerEmail: string;
  readonly ownerPhone: string | null;
  readonly ownerNationalId: string | null;
  readonly businessStructure: string | null;
  readonly registrationNumber: string | null;
  readonly businessKraPin: string | null;
  readonly description: string | null;
  readonly physicalAddress: string | null;
  readonly county: string | null;
  readonly permitNumber: string | null;
  readonly businessPhone: string | null;
  readonly businessEmail: string | null;
  readonly formVersion: number;
  readonly status: TenantApplicationStatus;
  readonly source: TenantApplicationSource;
  readonly batchId: string | null;
  /** The CSV data-line number of a batch row (Task T-A6.3); null otherwise. */
  readonly batchRowNumber: number | null;
  readonly createdAt: Date;
  readonly submittedAt: Date;
  readonly reviewerUserId: string | null;
  readonly reviewStartedAt: Date | null;
  readonly changesRequested: string | null;
  readonly reviewedById: string | null;
  readonly reviewedAt: Date | null;
  readonly rejectionReason: string | null;
  readonly resultingTenantId: string | null;
}

export const APPLICATION_SELECT = {
  id: true,
  businessName: true,
  proposedSubdomain: true,
  sector: true,
  kraPin: true,
  taxRegime: true,
  requestedTier: true,
  ownerFullName: true,
  ownerEmail: true,
  ownerPhone: true,
  ownerNationalId: true,
  businessStructure: true,
  registrationNumber: true,
  businessKraPin: true,
  description: true,
  physicalAddress: true,
  county: true,
  permitNumber: true,
  businessPhone: true,
  businessEmail: true,
  formVersion: true,
  status: true,
  source: true,
  batchId: true,
  batchRowNumber: true,
  createdAt: true,
  submittedAt: true,
  reviewerUserId: true,
  reviewStartedAt: true,
  changesRequested: true,
  reviewedById: true,
  reviewedAt: true,
  rejectionReason: true,
  resultingTenantId: true,
} as const;

/** An application's fields as a candidate for the green-gate. */
export function applicationCandidate(app: ApplicationView): OnboardingCandidate {
  return {
    businessName: app.businessName,
    subdomain: app.source === "SELF_SERVE" ? null : app.proposedSubdomain,
    sector: app.sector,
    kraPin: app.kraPin,
    taxRegime: app.taxRegime,
    requestedTier: app.requestedTier,
    ownerFullName: app.ownerFullName,
    ownerEmail: app.ownerEmail,
    ownerPhone: app.ownerPhone,
    ownerNationalId: app.ownerNationalId,
    businessStructure: app.businessStructure,
    registrationNumber: app.registrationNumber,
    businessKraPin: app.businessKraPin,
    description: app.description,
    physicalAddress: app.physicalAddress,
    county: app.county,
    permitNumber: app.permitNumber,
    businessPhone: app.businessPhone,
    businessEmail: app.businessEmail,
  };
}

/** A normalised candidate as the columns an application stores. */
export function candidateColumns(c: NormalizedCandidate, proposedSubdomain: string | null) {
  return {
    businessName: c.businessName,
    proposedSubdomain,
    sector: c.sector,
    kraPin: c.kraPin,
    taxRegime: c.taxRegime,
    requestedTier: c.requestedTier,
    ownerFullName: c.ownerFullName,
    ownerEmail: c.ownerEmail,
    ownerPhone: c.ownerPhone,
    ownerNationalId: c.ownerNationalId,
    businessStructure: c.businessStructure,
    registrationNumber: c.registrationNumber,
    businessKraPin: c.businessKraPin,
    description: c.description,
    physicalAddress: c.physicalAddress,
    county: c.county,
    permitNumber: c.permitNumber,
    businessPhone: c.businessPhone,
    businessEmail: c.businessEmail,
  };
}

/** Administrative details a reviewer may correct, transparently. */
export const MINOR_FIELDS = ["sector", "description", "physicalAddress", "county", "permitNumber", "businessPhone", "businessEmail", "requestedTier"] as const;
export type MinorField = (typeof MINOR_FIELDS)[number];
/** Identity and ownership: only the applicant changes these (a request for changes). */
export const SUBSTANTIVE_FIELDS = [
  "businessName",
  "businessStructure",
  "registrationNumber",
  "kraPin",
  "businessKraPin",
  "taxRegime",
  "ownerFullName",
  "ownerEmail",
  "ownerPhone",
  "ownerNationalId",
] as const;

// ---- The applicant's access token -----------------------------------------------

export const ACCESS_TOKEN_TTL_DAYS = 90;

/** The one answer for any application link that does not open anything. */
export class ApplicationLinkError extends Error {
  constructor() {
    super("This application link is not valid or has expired. Use the most recent link we sent you.");
    this.name = "ApplicationLinkError";
  }
}

/** Mints a fresh access token for the applicant; only its hash is stored. */
export async function mintAccessToken(tx: PlatformTx, applicationId: string): Promise<string> {
  const token = issueSecretToken();
  const now = new Date();
  await tx.applicationAccessToken.create({
    data: { applicationId, tokenHash: token.hash, createdAt: now, expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_DAYS * 86_400_000) },
  });
  return token.raw;
}

/** The status page with the secret in the URL FRAGMENT, which no server and no log ever sees. */
export function statusLink(rawToken: string): string {
  return `${env.appBaseUrl}/application/status#${encodeURIComponent(rawToken)}`;
}

async function applicationForToken(rawToken: string): Promise<ApplicationView> {
  const row = await platformDb.applicationAccessToken.findUnique({
    where: { tokenHash: hashSecretToken(rawToken) },
    select: { expiresAt: true, application: { select: APPLICATION_SELECT } },
  });
  if (row === null || row.expiresAt.getTime() <= Date.now() || row.application.source !== "SELF_SERVE") {
    throw new ApplicationLinkError();
  }
  return row.application;
}

// ---- Notifications ----------------------------------------------------------------

type NoticeKind = "RECEIVED" | "REVIEW_STARTED" | "NEEDS_CHANGES" | "APPROVED" | "REJECTED";

/**
 * Tells the applicant (email, and SMS when a phone is on file), with a FRESH status link. A
 * delivery failure is recorded in notification_logs and never undoes the step.
 */
async function notifyApplicant(app: ApplicationView, kind: NoticeKind, message: string | null): Promise<void> {
  const raw = await mintAccessToken(platformDb, app.id);
  const template = {
    key: "application-status" as const,
    kind,
    ownerName: app.ownerFullName,
    businessName: app.businessName,
    message,
    statusLink: statusLink(raw),
  };
  const related = { type: "TenantApplication", id: app.id };
  await sendNotification({ channel: "EMAIL", to: app.ownerEmail, template, related });
  if (app.ownerPhone !== null) {
    await sendNotification({ channel: "SMS", to: app.ownerPhone, template, related });
  }
}

// ---- The public application ------------------------------------------------------

/** Clashes an anonymous caller must NOT learn about (they would confirm a registration). */
const HIDDEN_DUPLICATES: ReadonlySet<string> = new Set(["kraPin", "businessKraPin", "ownerNationalId", "ownerEmail"]);

function revealable(errors: readonly CandidateError[]): CandidateError[] {
  return errors.filter((e) => !(e.code === "DUPLICATE" && HIDDEN_DUPLICATES.has(e.field)));
}

export type DraftOutcome =
  | { readonly kind: "REFUSED"; readonly errors: readonly CandidateError[] }
  | { readonly kind: "CREATED"; readonly applicationId: string; readonly accessToken: string };

/** Starts an application as a DRAFT. Required fields are enforced at SUBMIT, except the owner's phone, which the draft is first saved with. */
export async function createDraftApplication(candidate: OnboardingCandidate): Promise<DraftOutcome> {
  const validation = await validateOnboardingCandidate({ ...candidate, subdomain: null }, { ownerPhoneRequired: true });
  const errors = revealable(validation.errors);
  if (errors.length > 0) {
    return { kind: "REFUSED", errors };
  }
  return platformDb.$transaction(async (tx) => {
    const created = await tx.tenantApplication.create({
      data: { ...candidateColumns(validation.normalized, validation.proposedSubdomain), source: "SELF_SERVE", status: "DRAFT", formVersion: 2 },
      select: { id: true },
    });
    return { kind: "CREATED" as const, applicationId: created.id, accessToken: await mintAccessToken(tx, created.id) };
  });
}

function assertEditable(app: ApplicationView): void {
  if (app.status !== "DRAFT" && app.status !== "NEEDS_CHANGES") {
    throw new TenantAdminError(409, `The application is ${app.status.replace(/_/g, " ").toLowerCase()} and cannot be edited now.`);
  }
}

export type UpdateOutcome = { readonly kind: "REFUSED"; readonly errors: readonly CandidateError[] } | { readonly kind: "UPDATED" };

/** The applicant edits their own DRAFT, or a NEEDS_CHANGES application. */
export async function updateApplicantApplication(rawToken: string, patch: Partial<OnboardingCandidate>): Promise<UpdateOutcome> {
  const app = await applicationForToken(rawToken);
  assertEditable(app);
  const merged = { ...applicationCandidate(app), ...patch, subdomain: null };
  const validation = await validateOnboardingCandidate(merged, { excludeApplicationId: app.id, ownerPhoneRequired: true });
  const errors = revealable(validation.errors);
  if (errors.length > 0) {
    return { kind: "REFUSED", errors };
  }
  await platformDb.tenantApplication.update({
    where: { id: app.id },
    data: candidateColumns(validation.normalized, validation.proposedSubdomain),
  });
  return { kind: "UPDATED" };
}

export async function uploadApplicantDocument(rawToken: string, side: DocumentSide, bytes: Buffer, declaredType: string | null): Promise<DocumentMeta> {
  const app = await applicationForToken(rawToken);
  assertEditable(app);
  return platformDb.$transaction((tx) => storeDocument(tx, app.id, side, bytes, declaredType));
}

/** DRAFT -> SUBMITTED, or NEEDS_CHANGES -> SUBMITTED (a resubmission), with every requirement met. */
export async function submitApplicantApplication(rawToken: string, ipAddress: string | null): Promise<UpdateOutcome> {
  const app = await applicationForToken(rawToken);
  assertEditable(app);
  const validation = await validateOnboardingCandidate(applicationCandidate(app), { excludeApplicationId: app.id, comprehensive: true, ownerPhoneRequired: true });
  const errors = revealable(validation.errors);
  const docs = (await documentMeta(app.id)).filter((doc) => doc.purgedAt === null);
  for (const side of ["FRONT", "BACK"] as const) {
    if (!docs.some((doc) => doc.side === side)) {
      errors.push({ field: "ownerNationalId", code: "REQUIRED", message: `Upload the ${side.toLowerCase()} of the owner's ID.` });
    }
  }
  if (errors.length > 0) {
    return { kind: "REFUSED", errors };
  }
  const resubmission = app.status === "NEEDS_CHANGES";
  const submitted = await platformDb.$transaction(async (tx) => {
    const row = await tx.tenantApplication.update({
      where: { id: app.id },
      data: {
        ...candidateColumns(validation.normalized, validation.proposedSubdomain),
        status: "SUBMITTED",
        submittedAt: new Date(),
        changesRequested: null,
        reviewerUserId: null,
        reviewStartedAt: null,
      },
      select: APPLICATION_SELECT,
    });
    await tx.tenantApplicationEvent.create({ data: { applicationId: app.id, kind: resubmission ? "RESUBMITTED" : "SUBMITTED" } });
    await recordAudit(tx, {
      action: resubmission ? "APPLICATION_RESUBMITTED" : "APPLICATION_SUBMITTED",
      actorUserId: null,
      targetUserId: null,
      tenantId: null,
      ipAddress,
      metadata: { applicationId: app.id, businessName: row.businessName, source: "SELF_SERVE" },
    });
    return row;
  });
  await notifyApplicant(submitted, "RECEIVED", null);
  return { kind: "UPDATED" };
}

// ---- The applicant's status page -------------------------------------------------

export interface ApplicantStatus {
  readonly status: TenantApplicationStatus;
  readonly application: {
    readonly businessName: string;
    readonly businessStructure: string | null;
    readonly registrationNumber: string | null;
    readonly businessKraPin: string | null;
    readonly kraPin: string | null;
    readonly taxRegime: string;
    readonly sector: string | null;
    readonly description: string | null;
    readonly physicalAddress: string | null;
    readonly county: string | null;
    readonly permitNumber: string | null;
    readonly businessPhone: string | null;
    readonly businessEmail: string | null;
    readonly requestedTier: string | null;
    readonly ownerFullName: string;
    readonly ownerEmail: string;
    readonly ownerPhone: string | null;
    /** Masked: the applicant knows it; a link that leaks must not reveal it. */
    readonly ownerNationalIdMasked: string | null;
  };
  readonly documents: Array<{ side: string; contentType: string; byteSize: number; uploadedAt: Date; deleted: boolean }>;
  readonly changesRequested: string | null;
  readonly rejectionReason: string | null;
  readonly timeline: Array<{ kind: string; message: string | null; corrections: Array<{ field: string; from: string | null; to: string | null }>; at: Date }>;
  readonly nextActions: ("COMPLETE_AND_SUBMIT" | "MAKE_CHANGES_AND_RESUBMIT" | "WAIT_FOR_REVIEW" | "SIGN_IN_FROM_INVITATION" | "APPLY_AGAIN")[];
  readonly editable: boolean;
}

function mask(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= 3 ? "***" : `${"*".repeat(value.length - 3)}${value.slice(-3)}`;
}

interface CorrectionDetail {
  field: string;
  from: string | null;
  to: string | null;
}

function correctionsOf(details: unknown): CorrectionDetail[] {
  if (typeof details !== "object" || details === null) return [];
  const list = (details as { corrections?: unknown }).corrections;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is CorrectionDetail => typeof item === "object" && item !== null && typeof (item as CorrectionDetail).field === "string");
}

export async function applicantStatus(rawToken: string): Promise<ApplicantStatus> {
  const app = await applicationForToken(rawToken);
  const [docs, events] = await Promise.all([
    documentMeta(app.id),
    platformDb.tenantApplicationEvent.findMany({ where: { applicationId: app.id }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] }),
  ]);
  const nextActions: ApplicantStatus["nextActions"][number][] =
    app.status === "DRAFT"
      ? ["COMPLETE_AND_SUBMIT"]
      : app.status === "NEEDS_CHANGES"
        ? ["MAKE_CHANGES_AND_RESUBMIT"]
        : app.status === "APPROVED"
          ? ["SIGN_IN_FROM_INVITATION"]
          : app.status === "REJECTED"
            ? ["APPLY_AGAIN"]
            : ["WAIT_FOR_REVIEW"];
  return {
    status: app.status,
    application: {
      businessName: app.businessName,
      businessStructure: app.businessStructure,
      registrationNumber: app.registrationNumber,
      businessKraPin: app.businessKraPin,
      kraPin: app.kraPin,
      taxRegime: app.taxRegime,
      sector: app.sector,
      description: app.description,
      physicalAddress: app.physicalAddress,
      county: app.county,
      permitNumber: app.permitNumber,
      businessPhone: app.businessPhone,
      businessEmail: app.businessEmail,
      requestedTier: app.requestedTier,
      ownerFullName: app.ownerFullName,
      ownerEmail: app.ownerEmail,
      ownerPhone: app.ownerPhone,
      ownerNationalIdMasked: mask(app.ownerNationalId),
    },
    documents: docs.map((doc) => ({ side: doc.side, contentType: doc.contentType, byteSize: doc.byteSize, uploadedAt: doc.uploadedAt, deleted: doc.purgedAt !== null })),
    changesRequested: app.status === "NEEDS_CHANGES" ? app.changesRequested : null,
    rejectionReason: app.status === "REJECTED" ? app.rejectionReason : null,
    timeline: events.map((event) => ({ kind: event.kind, message: event.message, corrections: correctionsOf(event.details), at: event.occurredAt })),
    nextActions,
    editable: app.status === "DRAFT" || app.status === "NEEDS_CHANGES",
  };
}

// ---- The queue (platform staff) -------------------------------------------------

export async function listApplications(filter: {
  status: TenantApplicationStatus | null;
  source: TenantApplicationSource | null;
}): Promise<ApplicationView[]> {
  return platformDb.tenantApplication.findMany({
    // A DRAFT is the applicant's unfinished form: it is not shown to staff.
    where: {
      status: filter.status !== null && filter.status !== "DRAFT" ? filter.status : { not: "DRAFT" },
      ...(filter.source !== null ? { source: filter.source } : {}),
    },
    orderBy: [{ submittedAt: "asc" }],
    select: APPLICATION_SELECT,
  });
}

export async function loadApplication(id: string): Promise<ApplicationView> {
  const app = await platformDb.tenantApplication.findUnique({ where: { id }, select: APPLICATION_SELECT });
  if (app === null || app.status === "DRAFT") {
    throw new TenantAdminError(404, "No such application.");
  }
  return app;
}

const OPEN: readonly TenantApplicationStatus[] = ["SUBMITTED", "UNDER_REVIEW", "NEEDS_CHANGES"];

/** The application, its documents' metadata, its timeline and the green-gate as it stands NOW. */
export async function reviewApplication(id: string): Promise<{
  application: ApplicationView;
  validation: CandidateValidation | null;
  documents: DocumentMeta[];
  timeline: Array<{ kind: string; actorUserId: string | null; message: string | null; details: unknown; occurredAt: Date }>;
}> {
  const application = await loadApplication(id);
  const [documents, events] = await Promise.all([
    documentMeta(id),
    platformDb.tenantApplicationEvent.findMany({ where: { applicationId: id }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] }),
  ]);
  const timeline = events.map((e) => ({ kind: e.kind, actorUserId: e.actorUserId, message: e.message, details: e.details, occurredAt: e.occurredAt }));
  if (!OPEN.includes(application.status)) {
    return { application, validation: null, documents, timeline };
  }
  const validation = await validateOnboardingCandidate(applicationCandidate(application), {
    excludeApplicationId: application.id,
    comprehensive: application.formVersion === 2,
    ...(application.batchId !== null ? { excludeBatchId: application.batchId } : {}),
  });
  return { application, validation, documents, timeline };
}

// ---- The billing seam -------------------------------------------------------------

/**
 * THE BILLING SEAM — the ONE place a subscription / payment gate goes, BEFORE anything is
 * provisioned. Bill-later, as decided: today it only resolves the tier to provision (the
 * requested one, or MWANZO), and provisioning starts the subscription TRIALING. When
 * billing lands, the payment or subscription check is inserted HERE and refuses (or
 * defers) the approval before provisionTenant() runs — one insertion, not a refactor.
 */
export function billingSeam(candidate: NormalizedCandidate): NormalizedCandidate {
  return { ...candidate, requestedTier: candidate.requestedTier ?? "MWANZO" };
}

// ---- Review steps -----------------------------------------------------------------

function redReason(errors: readonly CandidateError[]): string {
  return `The application is no longer green and cannot be approved: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`;
}

function assertSelfServe(app: ApplicationView): void {
  if (app.source === "BATCH") {
    throw new TenantAdminError(409, "A batch row is not reviewed on its own: correct or remove it, and commit its batch.");
  }
}

function assertStatus(app: ApplicationView, expected: TenantApplicationStatus, action: string): void {
  if (app.status !== expected) {
    throw new TenantAdminError(409, `The application is ${app.status}; it must be ${expected} to ${action}.`);
  }
}

export async function startReview(actor: Actor, id: string): Promise<ApplicationView> {
  const app = await loadApplication(id);
  assertSelfServe(app);
  assertStatus(app, "SUBMITTED", "start a review");
  const started = await platformDb.$transaction(async (tx) => {
    const row = await tx.tenantApplication.update({
      where: { id },
      data: { status: "UNDER_REVIEW", reviewerUserId: actor.userId, reviewStartedAt: new Date() },
      select: APPLICATION_SELECT,
    });
    await tx.tenantApplicationEvent.create({ data: { applicationId: id, kind: "REVIEW_STARTED", actorUserId: actor.userId } });
    await recordAudit(tx, { action: "APPLICATION_REVIEW_STARTED", actorUserId: actor.userId, targetUserId: null, tenantId: null, ipAddress: actor.ipAddress, metadata: { applicationId: id } });
    return row;
  });
  await notifyApplicant(started, "REVIEW_STARTED", null);
  return started;
}

export async function requestChanges(actor: Actor, id: string, message: string): Promise<ApplicationView> {
  const text = message.trim();
  if (text.length < 5) {
    throw new TenantAdminError(400, "Say what the applicant needs to change (at least 5 characters).");
  }
  const app = await loadApplication(id);
  assertSelfServe(app);
  assertStatus(app, "UNDER_REVIEW", "request changes");
  const changed = await platformDb.$transaction(async (tx) => {
    const row = await tx.tenantApplication.update({ where: { id }, data: { status: "NEEDS_CHANGES", changesRequested: text }, select: APPLICATION_SELECT });
    await tx.tenantApplicationEvent.create({ data: { applicationId: id, kind: "CHANGES_REQUESTED", actorUserId: actor.userId, message: text } });
    await recordAudit(tx, { action: "APPLICATION_CHANGES_REQUESTED", actorUserId: actor.userId, targetUserId: null, tenantId: null, ipAddress: actor.ipAddress, metadata: { applicationId: id } });
    return row;
  });
  await notifyApplicant(changed, "NEEDS_CHANGES", text);
  return changed;
}

/**
 * A reviewer corrects ADMINISTRATIVE details (MINOR_FIELDS) of an application UNDER_REVIEW —
 * transparently: every change, with its before and after, goes on the applicant's timeline and
 * the audit log. Anything substantive is refused: it is the applicant's to change.
 */
export async function correctApplication(
  actor: Actor,
  id: string,
  patch: Readonly<Record<string, string | null | undefined>>,
  note: string | null,
): Promise<ApplicationView> {
  const substantive = Object.keys(patch).filter((key) => (SUBSTANTIVE_FIELDS as readonly string[]).includes(key));
  if (substantive.length > 0) {
    throw new TenantAdminError(
      400,
      `${substantive.join(", ")} ${substantive.length === 1 ? "is an identity or ownership detail" : "are identity or ownership details"}: request the change from the applicant instead.`,
    );
  }
  const unknown = Object.keys(patch).filter((key) => !(MINOR_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new TenantAdminError(400, `Not a correctable field: ${unknown.join(", ")}.`);
  }
  const app = await loadApplication(id);
  assertSelfServe(app);
  assertStatus(app, "UNDER_REVIEW", "correct it");
  const validation = await validateOnboardingCandidate({ ...applicationCandidate(app), ...patch }, { excludeApplicationId: id });
  const formatErrors = validation.errors.filter((e) => e.code !== "DUPLICATE" && (MINOR_FIELDS as readonly string[]).includes(e.field));
  if (formatErrors.length > 0) {
    throw new TenantAdminError(400, formatErrors.map((e) => `${e.field}: ${e.message}`).join("; "));
  }
  const next = validation.normalized;
  const corrections: CorrectionDetail[] = [];
  for (const field of MINOR_FIELDS) {
    if (patch[field] === undefined) continue;
    const before = app[field];
    const after = next[field];
    if (before !== after) corrections.push({ field, from: before, to: after });
  }
  if (corrections.length === 0) {
    throw new TenantAdminError(400, "Nothing to correct: every value is already as given.");
  }
  return platformDb.$transaction(async (tx) => {
    const data: Record<string, string | null> = {};
    for (const correction of corrections) data[correction.field] = correction.to;
    const row = await tx.tenantApplication.update({ where: { id }, data, select: APPLICATION_SELECT });
    await tx.tenantApplicationEvent.create({
      data: { applicationId: id, kind: "CORRECTED", actorUserId: actor.userId, message: note, details: { corrections: corrections.map((c) => ({ ...c })) } },
    });
    await recordAudit(tx, {
      action: "APPLICATION_CORRECTED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: null,
      ipAddress: actor.ipAddress,
      metadata: { applicationId: id, fields: corrections.map((c) => c.field).join(",") },
    });
    return row;
  });
}

export async function approveApplication(actor: Actor, id: string): Promise<{ application: ApplicationView; onboarded: OnboardedTenant }> {
  assertMayProvision(actor);
  const app = await loadApplication(id);
  assertSelfServe(app);
  assertStatus(app, "UNDER_REVIEW", "approve it");

  // RE-VALIDATE NOW. Between submit and approve another business may have taken the
  // name, the PIN or the owner's identity; a hidden duplicate from submit surfaces here.
  const validation = await validateOnboardingCandidate(applicationCandidate(app), {
    excludeApplicationId: app.id,
    comprehensive: app.formVersion === 2,
  });
  if (validation.status !== "GREEN" || validation.proposedSubdomain === null) {
    throw new TenantAdminError(409, redReason(validation.errors));
  }

  const candidate = billingSeam(validation.normalized);
  const onboarded = await provisionGreenCandidate(actor, candidate, validation.proposedSubdomain, "SELF_SERVE", { applicationId: app.id });

  const application = await platformDb.$transaction(async (tx) => {
    const decided = await tx.tenantApplication.update({
      where: { id: app.id },
      data: {
        status: "APPROVED",
        proposedSubdomain: validation.proposedSubdomain,
        reviewedById: actor.userId,
        reviewedAt: new Date(),
        resultingTenantId: onboarded.tenant.id,
      },
      select: APPLICATION_SELECT,
    });
    await tx.tenantApplicationEvent.create({ data: { applicationId: app.id, kind: "APPROVED", actorUserId: actor.userId } });
    await recordAudit(tx, {
      action: "APPLICATION_APPROVED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: onboarded.tenant.id,
      ipAddress: actor.ipAddress,
      metadata: { applicationId: app.id, subdomain: onboarded.tenant.subdomain },
    });
    return decided;
  });
  await notifyApplicant(application, "APPROVED", null);
  return { application, onboarded };
}

export async function rejectApplication(actor: Actor, id: string, reason: string): Promise<ApplicationView> {
  const app = await loadApplication(id);
  assertSelfServe(app);
  assertStatus(app, "UNDER_REVIEW", "reject it");
  const decided = await platformDb.$transaction(async (tx) => {
    const row = await tx.tenantApplication.update({
      where: { id: app.id },
      data: { status: "REJECTED", rejectionReason: reason, reviewedById: actor.userId, reviewedAt: new Date() },
      select: APPLICATION_SELECT,
    });
    await tx.tenantApplicationEvent.create({ data: { applicationId: app.id, kind: "REJECTED", actorUserId: actor.userId, message: reason } });
    await recordAudit(tx, {
      action: "APPLICATION_REJECTED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: null,
      ipAddress: actor.ipAddress,
      metadata: { applicationId: app.id, businessName: app.businessName, reason },
    });
    return row;
  });
  await notifyApplicant(decided, "REJECTED", reason);
  return decided;
}
