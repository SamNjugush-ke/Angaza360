// ===========================================================================
// Admin onboarding of a business (Task T-A6.1; its provisioning step is reused by
// T-A6.2 approval and T-A6.3 batch commit).
//
// ONE PATH FROM A GREEN CANDIDATE TO A LIVE BUSINESS — provisionGreenCandidate:
//   1. provisionTenant() — the scripted, idempotent provisioning every tenant goes
//      through (schema, every tenant migration, chart, statutory seed, MAIN location);
//   2. the declared tax regime is written to BOTH the registry field and the tenant's
//      own BusinessProfile (through the business-profile service), so the new business
//      posts under the regime it declared. That is "mirror at creation"; later edits are
//      T-A13's settings decision;
//   3. the first MSME_OWNER is invited through the Wave-1 inviteUser() — the same rules,
//      guard and single-use token as every invitation — carrying the owner's National ID;
//   4. TENANT_ONBOARDED is audited.
// It runs ONLY for a candidate the green-gate (./candidate.ts) passed. The ACTOR must be
// a SUPER_ADMIN: inviting an owner into a business is a role grant, and under the T-A5
// rule (service AND the user_invitation_guard trigger) only a SUPER_ADMIN grants a tenant
// role in a business they do not own. A PROGRAM_OFFICER prepares — validates, reviews,
// edits, rejects — and a SUPER_ADMIN provisions.
//
// IF THE INVITATION FAILS AFTER PROVISIONING the business exists without an owner; the
// error surfaces and the owner is invited again through /v1/users/invite. The green-gate
// checks the owner's email first precisely so this does not happen in the ordinary case.
// ===========================================================================

import { getTenantDb } from "../../db/tenant";
import type { SubscriptionTier, TaxRegime } from "../../generated/platform/enums";
import type { TenantTaxRegime } from "../../generated/tenant/enums";
import { platformDb } from "../../db/platform";
import { updateBusinessProfile } from "../business-profile";
import { recordAudit } from "../identity/audit";
import { inviteUser, type Actor, type InviteResult } from "../identity/user-management";
import { provisionTenant } from "../tenant-provisioning";
import { validateOnboardingCandidate, type CandidateError, type NormalizedCandidate, type OnboardingCandidate } from "./candidate";
import { getTenantView, TenantAdminError, type TenantView } from "./tenant-view";

export type OnboardingSource = "ADMIN" | "SELF_SERVE" | "BATCH";

export interface OnboardedTenant {
  readonly tenant: TenantView;
  readonly ownerInvitation: InviteResult;
}

export type OnboardingOutcome =
  | { readonly status: "ONBOARDED"; readonly onboarded: OnboardedTenant }
  | { readonly status: "RED"; readonly errors: readonly CandidateError[]; readonly proposedSubdomain: string | null };

/** The registry's spelling of the regime BusinessProfile uses. */
function registryRegime(regime: TenantTaxRegime): TaxRegime {
  return regime === "VAT_REGISTERED" ? "VAT" : regime;
}

export function assertMayProvision(actor: Actor): void {
  if (actor.role !== "SUPER_ADMIN") {
    throw new TenantAdminError(
      403,
      "Only a SUPER_ADMIN may provision a business and invite its owner. A PROGRAM_OFFICER may validate, review, edit and reject.",
    );
  }
}

/**
 * Provision a candidate the green-gate has ALREADY passed, and invite its owner. The
 * caller holds that guarantee; this function does not re-validate.
 */
export async function provisionGreenCandidate(
  actor: Actor,
  candidate: NormalizedCandidate,
  subdomain: string,
  source: OnboardingSource,
  context: Readonly<Record<string, string | null>> = {},
): Promise<OnboardedTenant> {
  assertMayProvision(actor);
  const regime = candidate.taxRegime as TenantTaxRegime;
  const provisioned = await provisionTenant({
    name: candidate.businessName,
    subdomain,
    ...(candidate.sector !== null ? { businessSector: candidate.sector } : {}),
    ...(candidate.kraPin !== null ? { kraPin: candidate.kraPin } : {}),
    ...(candidate.requestedTier !== null ? { subscriptionTier: candidate.requestedTier as SubscriptionTier } : {}),
  });
  // provisionTenant is idempotent BY SUBDOMAIN: if the subdomain was claimed after the
  // green-gate ran, it returns the EXISTING tenant. Inviting an owner into it would hand
  // someone else's business to this applicant, so a non-fresh result is refused.
  if (!provisioned.created) {
    throw new TenantAdminError(409, `The subdomain "${subdomain}" was taken before this business could be provisioned. Validate again.`);
  }
  await platformDb.tenant.update({ where: { id: provisioned.tenantId }, data: { taxRegime: registryRegime(regime) } });
  await updateBusinessProfile(getTenantDb(provisioned.schema), { taxRegime: regime });

  const ownerInvitation = await inviteUser(actor, {
    email: candidate.ownerEmail,
    role: "MSME_OWNER",
    tenantId: provisioned.tenantId,
    phone: candidate.ownerPhone,
    nationalId: candidate.ownerNationalId,
  });

  await recordAudit(platformDb, {
    action: "TENANT_ONBOARDED",
    actorUserId: actor.userId,
    targetUserId: null,
    tenantId: provisioned.tenantId,
    ipAddress: actor.ipAddress,
    metadata: { subdomain, businessName: candidate.businessName, source, invitationId: ownerInvitation.invitation.id, ...context },
  });
  return { tenant: await getTenantView(provisioned.tenantId), ownerInvitation };
}

/** The single admin entry: validate again, and provision + invite only when GREEN. */
export async function onboardTenant(actor: Actor, candidate: OnboardingCandidate): Promise<OnboardingOutcome> {
  assertMayProvision(actor);
  const validation = await validateOnboardingCandidate(candidate);
  if (validation.status !== "GREEN" || validation.proposedSubdomain === null) {
    return { status: "RED", errors: validation.errors, proposedSubdomain: validation.proposedSubdomain };
  }
  const onboarded = await provisionGreenCandidate(actor, validation.normalized, validation.proposedSubdomain, "ADMIN");
  return { status: "ONBOARDED", onboarded };
}
