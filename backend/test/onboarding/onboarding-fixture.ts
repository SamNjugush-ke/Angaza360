// ===========================================================================
// Onboarding fixtures (Task T-A6): platform staff, a fresh GREEN candidate, and the
// bookkeeping to drop every tenant a test provisions (users and invitations cascade with
// the tenant; audit rows stay by design).
// ===========================================================================

import { randomInt, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { platformDb } from "../../src/db/platform";
import { dropTenant } from "../setup/tenant";
import { createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";

export interface Candidate {
  businessName: string;
  subdomain?: string | null;
  sector?: string | null;
  kraPin?: string | null;
  taxRegime: string;
  requestedTier?: string | null;
  ownerFullName: string;
  ownerEmail: string;
  ownerPhone?: string | null;
  ownerNationalId?: string | null;
  // M4.5 W2 — the comprehensive application.
  businessStructure?: string | null;
  registrationNumber?: string | null;
  businessKraPin?: string | null;
  physicalAddress?: string | null;
  county?: string | null;
  businessPhone?: string | null;
  businessEmail?: string | null;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function freshKraPin(): string {
  const digits = Array.from({ length: 9 }, () => randomInt(0, 10).toString()).join("");
  return `P${digits}${LETTERS[randomInt(0, 26)] ?? "X"}`;
}

export function freshNationalId(): string {
  return randomInt(10_000_000, 99_999_999).toString();
}

export function freshCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const tag = randomUUID().slice(0, 8);
  return {
    businessName: `QA Onboarded ${tag}`,
    sector: "Retail",
    kraPin: freshKraPin(),
    taxRegime: "VAT_REGISTERED",
    requestedTier: "UKUAJI",
    ownerFullName: `QA Owner ${tag}`,
    ownerEmail: `qa-owner-${tag}@test.invalid`,
    ownerPhone: `+2547${randomInt(10_000_000, 99_999_999).toString()}`,
    ownerNationalId: freshNationalId(),
    ...overrides,
  };
}

export interface PlatformStaff {
  readonly superAdmin: SignedIn;
  readonly officer: SignedIn;
  readonly users: readonly StaffUser[];
}

export async function platformStaff(app: FastifyInstance): Promise<PlatformStaff> {
  const admin = await createStaffUser("SUPER_ADMIN", null);
  const officer = await createStaffUser("PROGRAM_OFFICER", null);
  return { superAdmin: await signIn(app, admin), officer: await signIn(app, officer), users: [admin, officer] };
}

/** Drops every tenant whose name a test registered, then the platform users. */
export async function cleanUp(subdomains: readonly string[], users: readonly StaffUser[]): Promise<void> {
  for (const subdomain of subdomains) {
    await dropTenant(subdomain);
  }
  await platformDb.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
}

// ---- The comprehensive public application (M4.5 W2) -----------------------------

/** A sole proprietor's complete application fields. */
export function freshApplicant(overrides: Partial<Candidate> = {}): Candidate {
  return freshCandidate({
    businessStructure: "SOLE_PROPRIETOR",
    physicalAddress: "Moi Avenue, Shop 12, Nakuru",
    county: "Nakuru",
    ...overrides,
  });
}

/** Smallest files that are structurally whole: what a real scan's signature and end look like. */
export function sampleJpeg(size = 2048): Buffer {
  const body = Buffer.alloc(size, 0x11);
  body[0] = 0xff;
  body[1] = 0xd8;
  body[2] = 0xff;
  body[3] = 0xe0;
  body[size - 2] = 0xff;
  body[size - 1] = 0xd9;
  return body;
}

export function samplePng(size = 2048): Buffer {
  const body = Buffer.alloc(size, 0x22);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body, 0);
  Buffer.from("IEND", "latin1").copy(body, size - 8);
  return body;
}

export function samplePdf(extra = ""): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), Buffer.alloc(1500, 0x20), Buffer.from(`${extra}\n%%EOF\n`, "latin1")]);
}

export interface Applied {
  readonly id: string;
  readonly token: string;
}

export function startApplication(app: FastifyInstance, candidate: Candidate, ip: string) {
  const { subdomain: _ignored, ...body } = candidate;
  return app.inject({ method: "POST", url: "/v1/public/applications", remoteAddress: ip, payload: body });
}

export function uploadSide(app: FastifyInstance, token: string, side: "FRONT" | "BACK", bytes: Buffer, contentType: string, ip: string) {
  return app.inject({
    method: "PUT",
    url: `/v1/public/applications/current/documents/${side}`,
    remoteAddress: ip,
    headers: { "x-application-token": token, "content-type": contentType },
    payload: bytes,
  });
}

export function submitApplication(app: FastifyInstance, token: string, ip: string) {
  return app.inject({ method: "POST", url: "/v1/public/applications/current/submit", remoteAddress: ip, headers: { "x-application-token": token } });
}

export function applicationStatus(app: FastifyInstance, token: string, ip: string) {
  return app.inject({ method: "GET", url: "/v1/public/applications/current", remoteAddress: ip, headers: { "x-application-token": token } });
}

/** Draft -> both ID sides -> submit, each request from its own address (the AUTH tier). */
export async function applyFully(app: FastifyInstance, candidate: Candidate, nextIp: () => string): Promise<Applied> {
  const started = await startApplication(app, candidate, nextIp());
  if (started.statusCode !== 201) throw new Error(`start failed ${started.statusCode.toString()}: ${started.body}`);
  const { applicationId, accessToken } = started.json<{ applicationId: string; accessToken: string }>();
  for (const [side, bytes, type] of [["FRONT", sampleJpeg(), "image/jpeg"], ["BACK", samplePng(), "image/png"]] as const) {
    const uploaded = await uploadSide(app, accessToken, side, bytes, type, nextIp());
    if (uploaded.statusCode !== 201) throw new Error(`upload failed ${uploaded.statusCode.toString()}: ${uploaded.body}`);
  }
  const submitted = await submitApplication(app, accessToken, nextIp());
  if (submitted.statusCode !== 202) throw new Error(`submit failed ${submitted.statusCode.toString()}: ${submitted.body}`);
  return { id: applicationId, token: accessToken };
}

/** Pending (non-final) applications a test made: DRAFT and SUBMITTED batch rows can go; others are permanent records. */
export async function removeDrafts(ids: readonly string[]): Promise<void> {
  await platformDb.tenantApplication.deleteMany({ where: { id: { in: [...ids] }, status: "DRAFT" } });
}
