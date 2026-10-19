// ===========================================================================
// Tenant applications: public self-serve signup + the approval queue (Task T-A6.2).
//
// SUBMIT (public, unauthenticated). The candidate goes through the green-gate. What the
// applicant may be TOLD is limited, because the endpoint is anonymous:
//   * a missing or malformed field, and a taken business NAME or SUBDOMAIN, are answered
//     400 — those are public facts ("pick another");
//   * a duplicate KRA PIN, owner National ID or owner email is NOT revealed: the
//     application is stored PENDING_APPROVAL and answered with the SAME neutral 202 as a
//     clean one. The reviewer sees the clash (the queue re-runs the gate), and approval
//     refuses it. Nothing is ever provisioned for it.
// No tenant exists until a SUPER_ADMIN approves.
//
// APPROVE re-runs the green-gate AT APPROVAL TIME — state may have changed since the
// applicant submitted (a name or PIN taken meanwhile) — and refuses with the reason when
// it is not GREEN. When GREEN it passes THE BILLING SEAM, then provisions through the one
// path (provisionGreenCandidate) and records the decision. A batch row is never approved
// here: it is committed with its batch (T-A6.3).
// ===========================================================================

import { platformDb } from "../../db/platform";
import type { TenantApplicationSource, TenantApplicationStatus } from "../../generated/platform/enums";
import { recordAudit } from "../identity/audit";
import type { Actor } from "../identity/user-management";
import {
  validateOnboardingCandidate,
  type CandidateError,
  type CandidateValidation,
  type NormalizedCandidate,
  type OnboardingCandidate,
} from "./candidate";
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
  readonly status: TenantApplicationStatus;
  readonly source: TenantApplicationSource;
  readonly batchId: string | null;
  /** The CSV data-line number of a batch row (Task T-A6.3); null otherwise. */
  readonly batchRowNumber: number | null;
  readonly submittedAt: Date;
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
  status: true,
  source: true,
  batchId: true,
  batchRowNumber: true,
  submittedAt: true,
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
  };
}

// ---- Submit (public) ---------------------------------------------------------

/** Clashes an anonymous caller must NOT learn about (they would confirm a registration). */
const HIDDEN_DUPLICATES: ReadonlySet<string> = new Set(["kraPin", "ownerNationalId", "ownerEmail"]);

export type SubmitOutcome =
  | { readonly kind: "REFUSED"; readonly errors: readonly CandidateError[] }
  | { readonly kind: "RECEIVED"; readonly applicationId: string };

export async function submitSelfServeApplication(candidate: OnboardingCandidate, ipAddress: string | null): Promise<SubmitOutcome> {
  const validation = await validateOnboardingCandidate({ ...candidate, subdomain: null });
  const revealable = validation.errors.filter((e) => !(e.code === "DUPLICATE" && HIDDEN_DUPLICATES.has(e.field)));
  if (revealable.length > 0) {
    return { kind: "REFUSED", errors: revealable };
  }
  const application = await platformDb.$transaction(async (tx) => {
    const created = await tx.tenantApplication.create({
      data: { ...candidateColumns(validation.normalized, validation.proposedSubdomain), source: "SELF_SERVE" },
      select: { id: true },
    });
    await recordAudit(tx, {
      action: "APPLICATION_SUBMITTED",
      actorUserId: null,
      targetUserId: null,
      tenantId: null,
      ipAddress,
      metadata: { applicationId: created.id, businessName: validation.normalized.businessName, source: "SELF_SERVE" },
    });
    return created;
  });
  return { kind: "RECEIVED", applicationId: application.id };
}

// ---- The queue -----------------------------------------------------------------

export async function listApplications(filter: {
  status: TenantApplicationStatus | null;
  source: TenantApplicationSource | null;
}): Promise<ApplicationView[]> {
  return platformDb.tenantApplication.findMany({
    where: {
      ...(filter.status !== null ? { status: filter.status } : {}),
      ...(filter.source !== null ? { source: filter.source } : {}),
    },
    orderBy: [{ submittedAt: "asc" }],
    select: APPLICATION_SELECT,
  });
}

export async function loadApplication(id: string): Promise<ApplicationView> {
  const app = await platformDb.tenantApplication.findUnique({ where: { id }, select: APPLICATION_SELECT });
  if (app === null) {
    throw new TenantAdminError(404, "No such application.");
  }
  return app;
}

/** The application plus the green-gate as it stands NOW (a pending row only). */
export async function reviewApplication(id: string): Promise<{ application: ApplicationView; validation: CandidateValidation | null }> {
  const application = await loadApplication(id);
  if (application.status !== "PENDING_APPROVAL") {
    return { application, validation: null };
  }
  const validation = await validateOnboardingCandidate(applicationCandidate(application), {
    excludeApplicationId: application.id,
    ...(application.batchId !== null ? { excludeBatchId: application.batchId } : {}),
  });
  return { application, validation };
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

// ---- Decide ----------------------------------------------------------------------

function redReason(errors: readonly CandidateError[]): string {
  return `The application is no longer green and cannot be approved: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`;
}

function assertDecidable(app: ApplicationView): void {
  if (app.status !== "PENDING_APPROVAL") {
    throw new TenantAdminError(409, `The application is ${app.status}; a decision is final.`);
  }
  if (app.source === "BATCH") {
    throw new TenantAdminError(409, "A batch row is not decided on its own: correct or remove it, and commit its batch.");
  }
}

export async function approveApplication(actor: Actor, id: string): Promise<{ application: ApplicationView; onboarded: OnboardedTenant }> {
  assertMayProvision(actor);
  const app = await loadApplication(id);
  assertDecidable(app);

  // RE-VALIDATE NOW. Between submit and approve another business may have taken the
  // name, the PIN or the owner's identity; a hidden duplicate from submit surfaces here.
  const validation = await validateOnboardingCandidate(applicationCandidate(app), { excludeApplicationId: app.id });
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
  return { application, onboarded };
}

export async function rejectApplication(actor: Actor, id: string, reason: string): Promise<ApplicationView> {
  const app = await loadApplication(id);
  assertDecidable(app);
  return platformDb.$transaction(async (tx) => {
    const decided = await tx.tenantApplication.update({
      where: { id: app.id },
      data: { status: "REJECTED", rejectionReason: reason, reviewedById: actor.userId, reviewedAt: new Date() },
      select: APPLICATION_SELECT,
    });
    await recordAudit(tx, {
      action: "APPLICATION_REJECTED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: null,
      ipAddress: actor.ipAddress,
      metadata: { applicationId: app.id, businessName: app.businessName, reason },
    });
    return decided;
  });
}
