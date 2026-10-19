// ===========================================================================
// Donor projects / cohorts: the projects, their member businesses, and CONSENT
// (Task T-A12). The only writer of donor_projects and donor_project_memberships.
//
// PLATFORM STAFF (SUPER_ADMIN, PROGRAM_OFFICER) create and close projects and add or
// remove member businesses — a project created with a code enrols every business whose
// registry `donorProjectCode` carries it, each PENDING. Nothing about a membership lets
// anyone read a business's books: a business is in its cohort's AGGREGATE only while its
// own MSME_OWNER has CONSENTED (Module 14's consent shape), and the owner may withdraw at
// any time. Every change is audited in the ONE identity audit log.
//
// THE OWNER'S VIEW is scoped to their own business: another business's membership is
// "not found" (404). The owner also reads the full donor access log of their own business.
// ===========================================================================

import { platformDb } from "../../db/platform";
import type { DonorConsentStatus, DonorProjectStatus, TenantStatus } from "../../generated/platform/enums";
import { recordAudit } from "../identity/audit";
import type { Actor } from "../identity/user-management";

export class DonorError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "DonorError";
    this.status = status;
  }
}

export interface DonorProjectView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly donor: string;
  readonly description: string | null;
  readonly status: DonorProjectStatus;
  readonly createdById: string;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
}

export interface MembershipView {
  readonly id: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly businessName: string;
  readonly tenantStatus: TenantStatus;
  readonly consentStatus: DonorConsentStatus;
  readonly consentByUserId: string | null;
  readonly consentAt: Date | null;
  readonly joinedAt: Date;
}

const PROJECT_SELECT = {
  id: true,
  code: true,
  name: true,
  donor: true,
  description: true,
  status: true,
  createdById: true,
  createdAt: true,
  closedAt: true,
} as const;

const MEMBERSHIP_SELECT = {
  id: true,
  projectId: true,
  tenantId: true,
  consentStatus: true,
  consentByUserId: true,
  consentAt: true,
  joinedAt: true,
  tenant: { select: { name: true, status: true } },
} as const;

type MembershipRow = {
  id: string;
  projectId: string;
  tenantId: string;
  consentStatus: DonorConsentStatus;
  consentByUserId: string | null;
  consentAt: Date | null;
  joinedAt: Date;
  tenant: { name: string; status: TenantStatus };
};

function membershipView(row: MembershipRow): MembershipView {
  return {
    id: row.id,
    projectId: row.projectId,
    tenantId: row.tenantId,
    businessName: row.tenant.name,
    tenantStatus: row.tenant.status,
    consentStatus: row.consentStatus,
    consentByUserId: row.consentByUserId,
    consentAt: row.consentAt,
    joinedAt: row.joinedAt,
  };
}

export async function loadProject(projectId: string): Promise<DonorProjectView> {
  const project = await platformDb.donorProject.findUnique({ where: { id: projectId }, select: PROJECT_SELECT });
  if (project === null) {
    throw new DonorError(404, "No such donor project.");
  }
  return project;
}

function assertActive(project: DonorProjectView): void {
  if (project.status !== "ACTIVE") {
    throw new DonorError(409, `Donor project ${project.code} is CLOSED.`);
  }
}

// ---- Projects -------------------------------------------------------------------------

export interface CreateProjectInput {
  readonly code: string;
  readonly name: string;
  readonly donor: string;
  readonly description: string | null;
}

export async function createProject(actor: Actor, input: CreateProjectInput): Promise<{ project: DonorProjectView; seeded: number }> {
  const code = input.code.trim().toUpperCase();
  if ((await platformDb.donorProject.count({ where: { code } })) > 0) {
    throw new DonorError(409, `A donor project with code ${code} already exists.`);
  }
  return platformDb.$transaction(async (tx) => {
    const project = await tx.donorProject.create({
      data: { code, name: input.name.trim(), donor: input.donor.trim(), description: input.description, createdById: actor.userId },
      select: PROJECT_SELECT,
    });
    await recordAudit(tx, {
      action: "DONOR_PROJECT_CREATED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: null,
      ipAddress: actor.ipAddress,
      metadata: { projectId: project.id, code },
    });
    // Seed from the registry: every business already tagged with this programme code.
    const tagged = await tx.tenant.findMany({
      where: { donorProjectCode: code, status: { not: "DEACTIVATED" } },
      select: { id: true },
    });
    for (const tenant of tagged) {
      await tx.donorProjectMembership.create({ data: { projectId: project.id, tenantId: tenant.id } });
      await recordAudit(tx, {
        action: "DONOR_MEMBER_ADDED",
        actorUserId: actor.userId,
        targetUserId: null,
        tenantId: tenant.id,
        ipAddress: actor.ipAddress,
        metadata: { projectId: project.id, code, seededFromRegistry: true },
      });
    }
    return { project, seeded: tagged.length };
  });
}

export async function listProjects(filter: { status: DonorProjectStatus | null }): Promise<DonorProjectView[]> {
  return platformDb.donorProject.findMany({
    where: filter.status === null ? {} : { status: filter.status },
    orderBy: [{ createdAt: "desc" }],
    select: PROJECT_SELECT,
  });
}

export async function getProject(projectId: string): Promise<{ project: DonorProjectView; members: MembershipView[] }> {
  const project = await loadProject(projectId);
  const rows = await platformDb.donorProjectMembership.findMany({
    where: { projectId },
    orderBy: [{ joinedAt: "asc" }],
    select: MEMBERSHIP_SELECT,
  });
  return { project, members: rows.map(membershipView) };
}

export async function closeProject(actor: Actor, projectId: string): Promise<DonorProjectView> {
  const project = await loadProject(projectId);
  assertActive(project);
  return platformDb.$transaction(async (tx) => {
    const closed = await tx.donorProject.update({ where: { id: projectId }, data: { status: "CLOSED", closedAt: new Date() }, select: PROJECT_SELECT });
    await recordAudit(tx, {
      action: "DONOR_PROJECT_CLOSED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: null,
      ipAddress: actor.ipAddress,
      metadata: { projectId, code: project.code },
    });
    return closed;
  });
}

// ---- Members ----------------------------------------------------------------------------

export async function addMember(actor: Actor, projectId: string, tenantId: string): Promise<MembershipView> {
  const project = await loadProject(projectId);
  assertActive(project);
  const tenant = await platformDb.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
  if (tenant === null || tenant.status === "DEACTIVATED") {
    throw new DonorError(404, "No such active business.");
  }
  if ((await platformDb.donorProjectMembership.count({ where: { projectId, tenantId } })) > 0) {
    throw new DonorError(409, "That business is already a member of the project.");
  }
  return platformDb.$transaction(async (tx) => {
    const row = await tx.donorProjectMembership.create({ data: { projectId, tenantId }, select: MEMBERSHIP_SELECT });
    await recordAudit(tx, {
      action: "DONOR_MEMBER_ADDED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId,
      ipAddress: actor.ipAddress,
      metadata: { projectId, code: project.code, seededFromRegistry: false },
    });
    return membershipView(row);
  });
}

export async function removeMember(actor: Actor, projectId: string, tenantId: string): Promise<void> {
  const project = await loadProject(projectId);
  assertActive(project);
  const membership = await platformDb.donorProjectMembership.findUnique({ where: { projectId_tenantId: { projectId, tenantId } }, select: { id: true } });
  if (membership === null) {
    throw new DonorError(404, "That business is not a member of the project.");
  }
  await platformDb.$transaction(async (tx) => {
    await tx.donorProjectMembership.delete({ where: { id: membership.id } });
    await recordAudit(tx, {
      action: "DONOR_MEMBER_REMOVED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId,
      ipAddress: actor.ipAddress,
      metadata: { projectId, code: project.code },
    });
  });
}

// ---- The owner's side: consent ------------------------------------------------------

function assertOwner(actor: Actor): string {
  if (actor.role !== "MSME_OWNER" || actor.tenantId === null) {
    throw new DonorError(403, "Only the business's owner gives or withdraws consent.");
  }
  return actor.tenantId;
}

export async function listOwnMemberships(actor: Actor): Promise<Array<{ membership: MembershipView; project: DonorProjectView }>> {
  const tenantId = assertOwner(actor);
  const rows = await platformDb.donorProjectMembership.findMany({
    where: { tenantId },
    orderBy: [{ joinedAt: "desc" }],
    select: { ...MEMBERSHIP_SELECT, project: { select: PROJECT_SELECT } },
  });
  return rows.map((row) => ({ membership: membershipView(row), project: row.project }));
}

async function ownMembership(actor: Actor, membershipId: string): Promise<{ membership: MembershipView; project: DonorProjectView }> {
  const tenantId = assertOwner(actor);
  const row = await platformDb.donorProjectMembership.findUnique({
    where: { id: membershipId },
    select: { ...MEMBERSHIP_SELECT, project: { select: PROJECT_SELECT } },
  });
  if (row === null || row.tenantId !== tenantId) {
    throw new DonorError(404, "No such membership for your business.");
  }
  return { membership: membershipView(row), project: row.project };
}

async function setConsent(actor: Actor, membershipId: string, to: "CONSENTED" | "WITHDRAWN"): Promise<MembershipView> {
  const { membership, project } = await ownMembership(actor, membershipId);
  assertActive(project);
  if (membership.consentStatus === to) {
    throw new DonorError(409, `Consent is already ${to}.`);
  }
  return platformDb.$transaction(async (tx) => {
    const row = await tx.donorProjectMembership.update({
      where: { id: membershipId },
      data: { consentStatus: to, consentByUserId: actor.userId, consentAt: new Date() },
      select: MEMBERSHIP_SELECT,
    });
    await recordAudit(tx, {
      action: to === "CONSENTED" ? "DONOR_CONSENT_GIVEN" : "DONOR_CONSENT_WITHDRAWN",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: membership.tenantId,
      ipAddress: actor.ipAddress,
      metadata: { projectId: project.id, code: project.code, membershipId },
    });
    return membershipView(row);
  });
}

export function giveConsent(actor: Actor, membershipId: string): Promise<MembershipView> {
  return setConsent(actor, membershipId, "CONSENTED");
}

export function withdrawConsent(actor: Actor, membershipId: string): Promise<MembershipView> {
  return setConsent(actor, membershipId, "WITHDRAWN");
}

export interface DonorAccessLogView {
  readonly id: string;
  readonly projectId: string;
  readonly readerUserId: string;
  readonly resource: string;
  readonly viewedAt: Date;
}

/** The owner's transparency view: every cohort read of their own business's books. */
export async function ownAccessLog(actor: Actor, membershipId: string): Promise<DonorAccessLogView[]> {
  const { membership } = await ownMembership(actor, membershipId);
  return platformDb.donorAccessLog.findMany({
    where: { projectId: membership.projectId, tenantId: membership.tenantId },
    orderBy: [{ viewedAt: "desc" }],
    select: { id: true, projectId: true, readerUserId: true, resource: true, viewedAt: true },
  });
}
