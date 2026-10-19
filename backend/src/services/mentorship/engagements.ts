// ===========================================================================
// MENTORSHIP ENGAGEMENTS (Module 14, Task 14.1) — the consent lifecycle.
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE `mentorship_engagements`. It touches no
// tenant schema at all: an engagement describes the mentoring RELATIONSHIP and lives in
// the platform schema. Reading a mentee's books is a separate, single door —
// `src/services/mentorship/access.ts` — which this module never opens.
//
// VISIBILITY IS THE ACCESS RULE, AND IT FAILS AS 404. A caller who may not see an
// engagement is told it does not exist (never "forbidden"), so a mentor or an owner
// can never learn which other relationships exist by probing ids. Every lookup goes
// through `visibleEngagement`.
//
//   SUPER_ADMIN / PROGRAM_OFFICER  every engagement (they create them)
//   MENTOR / COACH                 only engagements where they are the mentor
//   MSME_OWNER                     only engagements on their own business
//
// The database (platform migration 20261011150000) is the guarantee behind each
// transition: born INVITED, consent only by an active MSME_OWNER of THAT tenant, ACTIVE
// impossible without consent, ENDED terminal, consent immutable, no delete.
// ===========================================================================

import { platformDb } from "../../db/platform";
import type { MentorshipEngagementStatus, UserRole } from "../../generated/platform/enums";

/** The caller, as the session resolved it. Never taken from a request body. */
export interface MentorshipActor {
  userId: string;
  role: UserRole;
  tenantId: string | null;
}

/** Unknown OR not visible to this caller — deliberately indistinguishable. Route -> 404. */
export class MentorshipNotFoundError extends Error {
  constructor(message = "No such mentorship engagement.") {
    super(message);
    this.name = "MentorshipNotFoundError";
  }
}

/** The engagement's state forbids the operation. Route -> 409. */
export class MentorshipStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MentorshipStateError";
  }
}

/** Bad input (an unknown mentor, a non-mentor user, an inactive business). Route -> 400. */
export class MentorshipValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MentorshipValidationError";
  }
}

const ADMIN_ROLES: ReadonlySet<UserRole> = new Set(["SUPER_ADMIN", "PROGRAM_OFFICER"]);
const MENTOR_ROLES: ReadonlySet<UserRole> = new Set(["MENTOR", "COACH"]);

export function isMentorRole(role: UserRole): boolean {
  return MENTOR_ROLES.has(role);
}

export interface EngagementRow {
  id: string;
  mentorId: string;
  mentorName: string;
  mentorRole: UserRole;
  tenantId: string;
  businessName: string;
  status: MentorshipEngagementStatus;
  invitedById: string;
  consentGivenAt: Date | null;
  consentByUserId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ENGAGEMENT_INCLUDE = {
  mentor: { select: { fullName: true, role: true } },
  tenant: { select: { name: true } },
} as const;

interface RawEngagement {
  id: string;
  mentorId: string;
  tenantId: string;
  status: MentorshipEngagementStatus;
  invitedById: string;
  consentGivenAt: Date | null;
  consentByUserId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  mentor: { fullName: string; role: UserRole };
  tenant: { name: string };
}

function toRow(e: RawEngagement): EngagementRow {
  return {
    id: e.id,
    mentorId: e.mentorId,
    mentorName: e.mentor.fullName,
    mentorRole: e.mentor.role,
    tenantId: e.tenantId,
    businessName: e.tenant.name,
    status: e.status,
    invitedById: e.invitedById,
    consentGivenAt: e.consentGivenAt,
    consentByUserId: e.consentByUserId,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    endedReason: e.endedReason,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** The visibility filter for a caller — the one place the rule above is written. */
function visibilityWhere(actor: MentorshipActor): { mentorId?: string; tenantId?: string } | null {
  if (ADMIN_ROLES.has(actor.role)) {
    return {};
  }
  if (MENTOR_ROLES.has(actor.role)) {
    return { mentorId: actor.userId };
  }
  if (actor.role === "MSME_OWNER" && actor.tenantId !== null) {
    return { tenantId: actor.tenantId };
  }
  return null;
}

async function visibleEngagement(actor: MentorshipActor, id: string): Promise<RawEngagement> {
  const where = visibilityWhere(actor);
  if (where === null) {
    throw new MentorshipNotFoundError();
  }
  const engagement = await platformDb.mentorshipEngagement.findFirst({
    where: { id, ...where },
    include: ENGAGEMENT_INCLUDE,
  });
  if (engagement === null) {
    throw new MentorshipNotFoundError();
  }
  return engagement;
}

/** One engagement as the caller may see it (the visibility rule above), else 404. */
export async function getVisibleEngagement(actor: MentorshipActor, id: string): Promise<EngagementRow> {
  return toRow(await visibleEngagement(actor, id));
}

export interface CreateEngagementInput {
  mentorId: string;
  tenantId: string;
}

/**
 * An ADMIN invites a mentor to a business. The engagement is born INVITED and grants
 * NOTHING: the mentor has no access until the business's owner consents.
 */
export async function createEngagement(
  actor: MentorshipActor,
  input: CreateEngagementInput,
): Promise<EngagementRow> {
  if (!ADMIN_ROLES.has(actor.role)) {
    throw new MentorshipNotFoundError();
  }
  const mentor = await platformDb.user.findUnique({
    where: { id: input.mentorId },
    select: { role: true, tenantId: true, isActive: true },
  });
  if (mentor === null || !MENTOR_ROLES.has(mentor.role) || mentor.tenantId !== null || !mentor.isActive) {
    throw new MentorshipValidationError(
      "mentorId must be an active platform user (no business) with the MENTOR or COACH role.",
    );
  }
  const tenant = await platformDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: { status: true },
  });
  if (tenant === null || tenant.status !== "ACTIVE") {
    throw new MentorshipValidationError("tenantId must be an ACTIVE business.");
  }
  const live = await platformDb.mentorshipEngagement.findFirst({
    where: { mentorId: input.mentorId, tenantId: input.tenantId, status: { not: "ENDED" } },
    select: { id: true, status: true },
  });
  if (live !== null) {
    throw new MentorshipStateError(
      `This mentor already has a live (${live.status}) engagement with this business (${live.id}). One live engagement per pair: end it before inviting again.`,
    );
  }
  const created = await platformDb.mentorshipEngagement.create({
    data: { mentorId: input.mentorId, tenantId: input.tenantId, invitedById: actor.userId },
    include: ENGAGEMENT_INCLUDE,
  });
  return toRow(created);
}

export async function listEngagements(actor: MentorshipActor): Promise<EngagementRow[]> {
  const where = visibilityWhere(actor);
  if (where === null) {
    return [];
  }
  const rows = await platformDb.mentorshipEngagement.findMany({
    where,
    include: ENGAGEMENT_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toRow);
}

/**
 * THE BUSINESS'S CONSENT. Only an MSME_OWNER of the engaged business may give it, and
 * only to an INVITED engagement. Consent is stamped (who, when) in the same change that
 * makes the engagement ACTIVE — the database refuses ACTIVE without it.
 */
export async function consentToEngagement(actor: MentorshipActor, id: string): Promise<EngagementRow> {
  if (actor.role !== "MSME_OWNER") {
    throw new MentorshipNotFoundError();
  }
  const engagement = await visibleEngagement(actor, id);
  if (engagement.status !== "INVITED") {
    throw new MentorshipStateError(
      `This engagement is ${engagement.status}; consent can only be given to an INVITED engagement.`,
    );
  }
  const now = new Date();
  const updated = await platformDb.mentorshipEngagement.update({
    where: { id: engagement.id },
    data: { status: "ACTIVE", consentGivenAt: now, consentByUserId: actor.userId, startedAt: now },
    include: ENGAGEMENT_INCLUDE,
  });
  return toRow(updated);
}

/** The owner declines an invitation. The mentor never gains access. */
export async function declineEngagement(actor: MentorshipActor, id: string): Promise<EngagementRow> {
  if (actor.role !== "MSME_OWNER") {
    throw new MentorshipNotFoundError();
  }
  const engagement = await visibleEngagement(actor, id);
  if (engagement.status !== "INVITED") {
    throw new MentorshipStateError(
      `This engagement is ${engagement.status}; only an INVITED engagement can be declined (end an ACTIVE one instead).`,
    );
  }
  const updated = await platformDb.mentorshipEngagement.update({
    where: { id: engagement.id },
    data: { status: "ENDED", endedAt: new Date(), endedReason: "Declined by the business owner." },
    include: ENGAGEMENT_INCLUDE,
  });
  return toRow(updated);
}

/**
 * END an engagement — the mentor, the business's owner or an admin. Access stops at
 * once: the gate admits only ACTIVE engagements. Ending is terminal; re-engaging is a
 * new invitation and a new consent.
 */
export async function endEngagement(
  actor: MentorshipActor,
  id: string,
  reason: string | undefined,
): Promise<EngagementRow> {
  const engagement = await visibleEngagement(actor, id);
  if (engagement.status === "ENDED") {
    throw new MentorshipStateError("This engagement has already ended.");
  }
  const by = ADMIN_ROLES.has(actor.role) ? "an administrator" : MENTOR_ROLES.has(actor.role) ? "the mentor" : "the business owner";
  const updated = await platformDb.mentorshipEngagement.update({
    where: { id: engagement.id },
    data: { status: "ENDED", endedAt: new Date(), endedReason: reason ?? `Ended by ${by}.` },
    include: ENGAGEMENT_INCLUDE,
  });
  return toRow(updated);
}

export interface AccessLogRow {
  id: string;
  engagementId: string;
  mentorId: string;
  mentorName: string;
  tenantId: string;
  resource: string;
  viewedAt: Date;
}

/**
 * WHO READ THIS BUSINESS'S DATA, AND WHEN. The owner sees every read under an
 * engagement on their business; a mentor sees their own reads; an admin sees all.
 */
export async function listAccessLog(actor: MentorshipActor, id: string): Promise<AccessLogRow[]> {
  const engagement = await visibleEngagement(actor, id);
  const rows = await platformDb.mentorshipAccessLog.findMany({
    where: { engagementId: engagement.id },
    include: { mentor: { select: { fullName: true } } },
    orderBy: { viewedAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    engagementId: r.engagementId,
    mentorId: r.mentorId,
    mentorName: r.mentor.fullName,
    tenantId: r.tenantId,
    resource: r.resource,
    viewedAt: r.viewedAt,
  }));
}
