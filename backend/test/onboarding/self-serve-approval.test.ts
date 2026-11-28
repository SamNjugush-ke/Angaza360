// ===========================================================================
// THE PUBLIC APPLICATION, ITS REVIEW AND THE APPLICANT'S STATUS (T-A6.2, rebuilt in M4.5 W2).
//
// * An application is a DRAFT until submitted complete (fields + both ID sides); a DRAFT is
//   invisible to staff and reserves nothing.
// * THE STATE MACHINE is enforced, by the service and from raw SQL: no step is skipped;
//   NEEDS_CHANGES round-trips through the applicant; APPROVED / REJECTED are final.
// * A reviewer corrects administrative details transparently (on the applicant's timeline,
//   audited) and can never change identity or ownership — the database refuses it.
// * Enumeration-safe: a duplicate KRA PIN / National ID / email is never revealed, yet no
//   duplicate business is approved; a REJECTED name is free to register again.
// * The applicant is notified at each step, with a fresh status link; the status page shows the
//   submission (National ID masked), what to fix, the decision and the next step.
// * REGRESSION: approval provisions + invites (now carrying county, structure and the profile).
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { RATE_LIMITS } from "../../src/plugins/security";
import { buildServer } from "../../src/server";
import { simulatedOutbox } from "../../src/services/notifications/simulated-provider";
import { validateOnboardingCandidate } from "../../src/services/tenants/candidate";
import { provisionFixture, tenantDb } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { withPlatformTx } from "../support/platform-tx";
import { accessTokenFor, createFixtureUser, deleteUsers, freshIp, type TestUser } from "../security/http-app";
import { bearer } from "../identity/staff-fixture";
import {
  applicationStatus,
  applyFully,
  cleanUp,
  freshApplicant,
  freshKraPin,
  platformStaff,
  removeDrafts,
  startApplication,
  submitApplication,
  type PlatformStaff,
} from "./onboarding-fixture";

let app: FastifyInstance;
let staff: PlatformStaff;
let tenantOwner: TestUser;
const provisioned: string[] = [];
const applicationIds: string[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  staff = await platformStaff(app);
  tenantOwner = await createFixtureUser("MSME_OWNER");
});

afterAll(async () => {
  await removeDrafts(applicationIds);
  await deleteUsers([tenantOwner]);
  await cleanUp(provisioned, staff.users);
  await app.close();
});

async function applied(overrides: Parameters<typeof freshApplicant>[0] = {}) {
  const result = await applyFully(app, freshApplicant(overrides), freshIp);
  applicationIds.push(result.id);
  return result;
}

function act(id: string, action: string, payload?: Record<string, unknown>, token: string = staff.superAdmin.token) {
  return app.inject({ method: "POST", url: `/v1/tenant-applications/${id}/${action}`, remoteAddress: freshIp(), headers: bearer(token), ...(payload ? { payload } : {}) });
}

async function statusOf(token: string) {
  const response = await applicationStatus(app, token, freshIp());
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ status: string; changesRequested: string | null; rejectionReason: string | null; nextActions: string[]; timeline: Array<{ kind: string; message: string | null; corrections: Array<{ field: string; from: string | null; to: string | null }> }>; application: { ownerNationalIdMasked: string } }>();
}

/** The most recent status link sent to an address, and its token. */
function lastNotice(to: string): { body: string; token: string } {
  const message = [...simulatedOutbox()].reverse().find((m) => m.to === to && m.body.includes("/application/status#"));
  const token = decodeURIComponent(/\/application\/status#(\S+)/.exec(message?.body ?? "")?.[1] ?? "");
  return { body: message?.body ?? "", token };
}

describe("the draft, and submission", () => {
  it("a DRAFT reserves nothing, is invisible to staff, and cannot be submitted incomplete", async () => {
    const candidate = freshApplicant();
    const started = await startApplication(app, candidate, freshIp());
    expect(started.statusCode, started.body).toBe(201);
    const { applicationId, accessToken } = started.json<{ applicationId: string; accessToken: string }>();
    applicationIds.push(applicationId);
    expect((await platformDb.tenantApplication.findUniqueOrThrow({ where: { id: applicationId } })).status).toBe("DRAFT");
    expect((await app.inject({ method: "GET", url: `/v1/tenant-applications/${applicationId}`, headers: bearer(staff.superAdmin.token) })).statusCode).toBe(404);
    const queue = await app.inject({ method: "GET", url: "/v1/tenant-applications", headers: bearer(staff.superAdmin.token) });
    expect(queue.json<{ data: Array<{ id: string }> }>().data.some((row) => row.id === applicationId)).toBe(false);

    // Without the ID document it cannot be submitted — named, not guessed.
    const early = await submitApplication(app, accessToken, freshIp());
    expect(early.statusCode).toBe(400);
    expect(early.json<{ message: string }>().message).toMatch(/front of the owner's ID.*back of the owner's ID/);

    // A second applicant may use the same business name while this one is only a draft.
    const second = await startApplication(app, freshApplicant({ businessName: candidate.businessName }), freshIp());
    expect(second.statusCode).toBe(201);
    applicationIds.push(second.json<{ applicationId: string }>().applicationId);
  });

  it("the comprehensive form's rules: a company needs its own KRA PIN and registration number; a county must be real", async () => {
    const started = await startApplication(app, freshApplicant({ businessStructure: "LIMITED_COMPANY", county: "Atlantis" }), freshIp());
    expect(started.statusCode).toBe(400);
    expect(started.json<{ errors: Array<{ field: string }> }>().errors.map((e) => e.field)).toContain("county");
    const company = await startApplication(app, freshApplicant({ businessStructure: "LIMITED_COMPANY" }), freshIp());
    const token = company.json<{ applicationId: string; accessToken: string }>();
    applicationIds.push(token.applicationId);
    const refused = await submitApplication(app, token.accessToken, freshIp());
    const fields = refused.json<{ errors: Array<{ field: string }> }>().errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(["businessKraPin", "registrationNumber"]));
  });

  it("the owner's phone is required on the self-serve form and stored in E.164; other paths keep it optional", async () => {
    const fieldsOf = (response: { json: <T>() => T }) => response.json<{ errors: Array<{ field: string; code: string }> }>().errors;
    // Missing, or blank: a field error naming ownerPhone.
    for (const ownerPhone of [null, "   "]) {
      const refused = await startApplication(app, freshApplicant({ ownerPhone }), freshIp());
      expect(refused.statusCode).toBe(400);
      expect(fieldsOf(refused)).toContainEqual(expect.objectContaining({ field: "ownerPhone", code: "REQUIRED" }));
    }
    // Not a plausible number: a format error.
    for (const ownerPhone of ["0712 345", "+254 712 345 6789", "phone"]) {
      const refused = await startApplication(app, freshApplicant({ ownerPhone }), freshIp());
      expect(refused.statusCode, ownerPhone).toBe(400);
      expect(fieldsOf(refused)).toContainEqual(expect.objectContaining({ field: "ownerPhone", code: "FORMAT" }));
    }
    // A local Kenyan number is stored as +254...; another country keeps its own code.
    for (const [typed, stored] of [["0712 345 678", "+254712345678"], ["712345678", "+254712345678"], ["254712345678", "+254712345678"], ["+256 772 123 456", "+256772123456"]] as const) {
      const started = await startApplication(app, freshApplicant({ ownerPhone: typed }), freshIp());
      expect(started.statusCode, started.body).toBe(201);
      const { applicationId, accessToken } = started.json<{ applicationId: string; accessToken: string }>();
      applicationIds.push(applicationId);
      expect((await platformDb.tenantApplication.findUniqueOrThrow({ where: { id: applicationId } })).ownerPhone).toBe(stored);
      // An edit is normalised too, and cannot clear the phone.
      const edit = (ownerPhone: string | null) =>
        app.inject({ method: "PATCH", url: "/v1/public/applications/current", remoteAddress: freshIp(), headers: { "x-application-token": accessToken }, payload: { ownerPhone } });
      expect((await edit(null)).statusCode).toBe(400);
      expect((await edit("0799 000 111")).statusCode).toBe(204);
      expect((await platformDb.tenantApplication.findUniqueOrThrow({ where: { id: applicationId } })).ownerPhone).toBe("+254799000111");
    }
    // The admin and batch paths are unchanged: the owner's phone stays optional there.
    const adminCandidate = await validateOnboardingCandidate({ ...freshApplicant({ ownerPhone: null }), subdomain: null });
    expect(adminCandidate.errors.map((e) => e.field)).not.toContain("ownerPhone");
    expect(adminCandidate.normalized.ownerPhone).toBeNull();
  });

  it("submission notifies the owner with a status link, and the status page masks the National ID", async () => {
    const candidate = freshApplicant();
    const { token } = await applied(candidate);
    const notice = lastNotice(candidate.ownerEmail);
    expect(notice.body).toContain("we received the application");
    expect(notice.token).not.toBe("");
    const status = await statusOf(notice.token);
    expect(status.status).toBe("SUBMITTED");
    expect(status.nextActions).toEqual(["WAIT_FOR_REVIEW"]);
    expect(status.application.ownerNationalIdMasked).toMatch(/^\*+\d{3}$/);
    expect(JSON.stringify(status)).not.toContain(candidate.ownerNationalId ?? "never");
    // The draft's own token still opens it too; an unknown one is the one 404.
    expect((await statusOf(token)).status).toBe("SUBMITTED");
    expect((await applicationStatus(app, "not-a-real-application-token", freshIp())).statusCode).toBe(404);
  });

  it(`is rate-limited on the AUTH tier (${RATE_LIMITS.AUTH.max.toString()} per IP)`, async () => {
    const ip = freshIp();
    for (let i = 0; i < RATE_LIMITS.AUTH.max; i += 1) {
      expect((await startApplication(app, freshApplicant({ businessName: "" }), ip)).statusCode).toBe(400);
    }
    expect((await startApplication(app, freshApplicant({ businessName: "" }), ip)).statusCode).toBe(429);
  });
});

describe("the review state machine", () => {
  it("no skipping: a SUBMITTED application can be neither approved nor rejected nor sent back before review", async () => {
    const { id } = await applied();
    for (const [action, payload] of [["approve", undefined], ["reject", { reason: "Too early." }], ["request-changes", { message: "Too early to ask." }]] as const) {
      expect((await act(id, action, payload)).statusCode, action).toBe(409);
    }
    await withPlatformTx(async (client) => {
      await expectDbRefusal(
        client.query(`UPDATE public.tenant_applications SET "status" = 'REJECTED', "rejectionReason" = 'x', "reviewedAt" = now() WHERE "id" = $1`, [id]),
        { fn: "tenant_application_guard", message: /no step is skipped/ },
      );
    });
  });

  it("NEEDS_CHANGES round-trips through the applicant: told what to change, edits, resubmits, reviewed again, approved", async () => {
    const candidate = freshApplicant();
    const { id } = await applied(candidate);
    expect((await act(id, "start-review", undefined, staff.officer.token)).statusCode).toBe(200);
    expect(lastNotice(candidate.ownerEmail).body).toContain("started reviewing");
    const asked = await act(id, "request-changes", { message: "Please use the business name on your permit." }, staff.officer.token);
    expect(asked.statusCode).toBe(200);
    const notice = lastNotice(candidate.ownerEmail);
    expect(notice.body).toContain("Please use the business name on your permit.");
    const status = await statusOf(notice.token);
    expect(status).toMatchObject({ status: "NEEDS_CHANGES", changesRequested: "Please use the business name on your permit.", nextActions: ["MAKE_CHANGES_AND_RESUBMIT"] });

    const renamed = `${candidate.businessName} Traders`;
    const edit = await app.inject({
      method: "PATCH",
      url: "/v1/public/applications/current",
      remoteAddress: freshIp(),
      headers: { "x-application-token": notice.token },
      payload: { businessName: renamed },
    });
    expect(edit.statusCode, edit.body).toBe(204);
    expect((await submitApplication(app, notice.token, freshIp())).statusCode).toBe(202);
    expect((await platformDb.tenantApplication.findUniqueOrThrow({ where: { id } })).status).toBe("SUBMITTED");
    expect((await act(id, "start-review")).statusCode).toBe(200);
    const approved = await act(id, "approve");
    expect(approved.statusCode, approved.body).toBe(200);
    const tenant = approved.json<{ onboarded: { tenant: { id: string; subdomain: string } } }>().onboarded.tenant;
    provisioned.push(tenant.subdomain);
    expect((await platformDb.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).name).toBe(renamed);
    expect((await statusOf(lastNotice(candidate.ownerEmail).token)).nextActions).toEqual(["SIGN_IN_FROM_INVITATION"]);
    expect((await statusOf(lastNotice(candidate.ownerEmail).token)).timeline.map((e) => e.kind)).toEqual([
      "SUBMITTED",
      "REVIEW_STARTED",
      "CHANGES_REQUESTED",
      "RESUBMITTED",
      "REVIEW_STARTED",
      "APPROVED",
    ]);
  });

  it("identity and ownership cannot be changed behind the applicant (service AND database); administrative details are corrected transparently", async () => {
    const candidate = freshApplicant();
    const { id } = await applied(candidate);
    await act(id, "start-review");
    const substantive = await app.inject({
      method: "PATCH",
      url: `/v1/tenant-applications/${id}/corrections`,
      headers: bearer(staff.superAdmin.token),
      payload: { ownerFullName: "Someone Else" },
    });
    expect(substantive.statusCode).toBe(400);
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.tenant_applications SET "ownerEmail" = 'other@test.invalid' WHERE "id" = $1`, [id]), {
        fn: "tenant_application_guard",
        message: /identity and ownership/,
      });
    });

    const minor = await app.inject({
      method: "PATCH",
      url: `/v1/tenant-applications/${id}/corrections`,
      headers: bearer(staff.superAdmin.token),
      payload: { county: "nairobi", note: "The permit is from Nairobi." },
    });
    expect(minor.statusCode, minor.body).toBe(200);
    expect(minor.json<{ county: string }>().county).toBe("Nairobi");
    await act(id, "request-changes", { message: "Confirm the corrected county." });
    const status = await statusOf(lastNotice(candidate.ownerEmail).token);
    const correction = status.timeline.find((e) => e.kind === "CORRECTED");
    expect(correction).toMatchObject({ message: "The permit is from Nairobi.", corrections: [{ field: "county", from: "Nakuru", to: "Nairobi" }] });
    expect(await platformDb.auditLog.count({ where: { action: "APPLICATION_CORRECTED", metadata: { path: ["applicationId"], equals: id } } })).toBe(1);
  });

  it("rejection records and sends the reason, is final, and the rejected name is free to register again", async () => {
    const candidate = freshApplicant();
    const { id } = await applied(candidate);
    await act(id, "start-review", undefined, staff.officer.token);
    const rejected = await act(id, "reject", { reason: "Not an MSME." }, staff.officer.token);
    expect(rejected.statusCode).toBe(200);
    const notice = lastNotice(candidate.ownerEmail);
    expect(notice.body).toContain("Reason: Not an MSME.");
    expect(await statusOf(notice.token)).toMatchObject({ status: "REJECTED", rejectionReason: "Not an MSME.", nextActions: ["APPLY_AGAIN"] });
    expect((await act(id, "approve")).statusCode).toBe(409);
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.tenant_applications SET "status" = 'SUBMITTED', "reviewedAt" = NULL, "rejectionReason" = NULL WHERE "id" = $1`, [id]), {
        fn: "tenant_application_guard",
        message: /final/,
      });
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`DELETE FROM public.tenant_applications WHERE "id" = $1`, [id]), { fn: "tenant_application_guard", message: /permanent record/ });
    });
    // The name is not reserved by a rejection.
    const again = await applied({ businessName: candidate.businessName });
    expect((await platformDb.tenantApplication.findUniqueOrThrow({ where: { id: again.id } })).status).toBe("SUBMITTED");
  });

  it("the resting state is coherent: NEEDS_CHANGES without a message, and REJECTED without a reason, are refused by the CHECK", async () => {
    const { id } = await applied();
    await act(id, "start-review");
    for (const sql of [
      `UPDATE public.tenant_applications SET "status" = 'NEEDS_CHANGES' WHERE "id" = $1`,
      `UPDATE public.tenant_applications SET "status" = 'REJECTED', "reviewedAt" = now() WHERE "id" = $1`,
    ]) {
      await withPlatformTx(async (client) => {
        await expectDbRefusal(client.query(sql, [id]), { constraint: "tenant_application_decision_coherent", code: "23514" });
      });
    }
  });
});

describe("duplicates: prevented, never revealed", () => {
  it("a duplicate KRA PIN gets the same answers; the reviewer sees the clash; approval refuses it", async () => {
    const first = freshApplicant();
    await applied(first);
    const clash = await applied({ kraPin: first.kraPin ?? freshKraPin() });
    await act(clash.id, "start-review");
    const review = await app.inject({ method: "GET", url: `/v1/tenant-applications/${clash.id}`, headers: bearer(staff.officer.token) });
    expect(review.json()).toMatchObject({ validation: { status: "RED", errors: [{ field: "kraPin", code: "DUPLICATE" }] } });
    expect((await act(clash.id, "approve")).statusCode).toBe(409);
    // The applicant's own status page never mentions it.
    const status = await statusOf(clash.token);
    expect(JSON.stringify(status)).not.toMatch(/already registered|DUPLICATE/i);
  });

  it("approval re-checks: a name taken between submit and approve refuses it, provisioning nothing", async () => {
    const candidate = freshApplicant();
    const { id } = await applied(candidate);
    await act(id, "start-review");
    const sub = `qa-race-${randomUUID().slice(0, 6)}`;
    await provisionFixture(sub, candidate.businessName.toUpperCase());
    provisioned.push(sub);
    const tenantsBefore = await platformDb.tenant.count();
    const response = await act(id, "approve");
    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toMatch(/no longer green.*businessName/);
    expect(await platformDb.tenant.count()).toBe(tenantsBefore);
  });
});

describe("REGRESSION: approval provisions, invites, and now carries the application's facts", () => {
  it("county and structure reach the registry; the address, phone, email and PIN prefill the profile", async () => {
    const candidate = freshApplicant({ taxRegime: "TURNOVER_TAX", requestedTier: null, businessPhone: "+254711000111", businessEmail: "shop@test.invalid" });
    const { id } = await applied(candidate);
    await act(id, "start-review");
    const response = await act(id, "approve");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ application: { status: string }; onboarded: { tenant: { id: string; subdomain: string; subscriptionTier: string } } }>();
    provisioned.push(body.onboarded.tenant.subdomain);
    expect(body.onboarded.tenant.subscriptionTier).toBe("MWANZO");
    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: body.onboarded.tenant.id } });
    expect(tenant).toMatchObject({ status: "ACTIVE", county: "Nakuru", businessStructure: "SOLE_PROPRIETOR", kraPin: candidate.kraPin, taxRegime: "TURNOVER_TAX" });
    const profile = await tenantDb(body.onboarded.tenant.subdomain).businessProfile.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(profile).toMatchObject({ addressLine: "Moi Avenue, Shop 12, Nakuru", phone: "+254711000111", email: "shop@test.invalid", kraPin: candidate.kraPin });
    const invitation = await platformDb.userInvitation.findFirstOrThrow({ where: { email: candidate.ownerEmail, status: "PENDING" } });
    expect(invitation).toMatchObject({ role: "MSME_OWNER", tenantId: tenant.id });
    expect((await act(id, "approve")).statusCode).toBe(409);
  });

  it("the queue is platform-scoped; approving is SUPER_ADMIN only", async () => {
    const { id } = await applied();
    const ownerToken = await accessTokenFor(app, tenantOwner);
    expect((await app.inject({ method: "GET", url: "/v1/tenant-applications", headers: bearer(ownerToken) })).statusCode).toBe(403);
    const queue = await app.inject({ method: "GET", url: "/v1/tenant-applications?status=SUBMITTED", headers: bearer(staff.officer.token) });
    expect(queue.json<{ data: Array<{ status: string }> }>().data.every((row) => row.status === "SUBMITTED")).toBe(true);
    await act(id, "start-review", undefined, staff.officer.token);
    expect((await act(id, "approve", undefined, staff.officer.token)).statusCode).toBe(403);
  });
});
