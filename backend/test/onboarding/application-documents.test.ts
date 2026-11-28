// ===========================================================================
// THE OWNER'S ID DOCUMENT — DPA-secure handling (M4.5 Wave 2), adversarially.
//
// * Upload judges CONTENT, not name: a non-image, a mislabelled, truncated, oversize, too-small,
//   active-content PDF or a PDF carrying markup (a polyglot) is refused. An image's bytes are NOT
//   scanned for markup: compressed image data produces such sequences by chance.
// * Stored ENCRYPTED in the database only: the row never holds the plaintext.
// * Never in an ordinary response, the applicant's status page, or a log line; never at any
//   public path.
// * Visible ONLY to a SUPER_ADMIN or the officer reviewing it — through a single-use,
//   short-lived, per-user grant, both steps audited. Another officer, a mentor and business
//   staff are refused.
// * The database refuses adding, replacing or rewriting a document once submitted; the
//   retention purge removes the ciphertext and keeps a stub.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { platformDb } from "../../src/db/platform";
import { buildServer } from "../../src/server";
import { purgeExpiredDocuments, RETAIN_AFTER_DECISION_DAYS } from "../../src/services/tenants/documents";
import { expectDbRefusal } from "../support/db-errors";
import { captureOutput } from "../support/log-capture";
import { withPlatformTx } from "../support/platform-tx";
import { accessTokenFor, createFixtureUser, deleteUsers, freshIp, type TestUser } from "../security/http-app";
import { bearer, createStaffUser, signIn, type SignedIn } from "../identity/staff-fixture";
import {
  applicationStatus,
  applyFully,
  cleanUp,
  freshApplicant,
  platformStaff,
  removeDrafts,
  sampleJpeg,
  samplePdf,
  samplePng,
  startApplication,
  uploadSide,
  type PlatformStaff,
} from "./onboarding-fixture";

let app: FastifyInstance;
let staff: PlatformStaff;
let otherOfficer: SignedIn;
let mentor: SignedIn;
let owner: TestUser;
const applicationIds: string[] = [];

/** A JPEG that carries a recognisable marker in its body, so a leak of its bytes is detectable. */
const SENTINEL = "ANGAZA-ID-SENTINEL-7Q2X";
function markedJpeg(): Buffer {
  const bytes = sampleJpeg(4096);
  Buffer.from(SENTINEL, "latin1").copy(bytes, 100);
  return bytes;
}

/** A copy of `bytes` with `text` written at `offset` (inside the body, clear of the markers). */
function withBytes(bytes: Buffer, text: string, offset: number): Buffer {
  const copy = Buffer.from(bytes);
  Buffer.from(text, "latin1").copy(copy, offset);
  return copy;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  staff = await platformStaff(app);
  const officer = await createStaffUser("PROGRAM_OFFICER", null);
  const mentorUser = await createStaffUser("MENTOR", null);
  otherOfficer = await signIn(app, officer);
  mentor = await signIn(app, mentorUser);
  owner = await createFixtureUser("MSME_OWNER");
  extraUsers.push(officer.id, mentorUser.id);
});

const extraUsers: string[] = [];

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await removeDrafts(applicationIds);
  await deleteUsers([owner]);
  await platformDb.user.deleteMany({ where: { id: { in: extraUsers } } });
  await cleanUp([], staff.users);
  await app.close();
});

async function draft(): Promise<{ id: string; token: string }> {
  const started = await startApplication(app, freshApplicant(), freshIp());
  const body = started.json<{ applicationId: string; accessToken: string }>();
  applicationIds.push(body.applicationId);
  return { id: body.applicationId, token: body.accessToken };
}

async function underReview(): Promise<{ id: string; token: string; frontId: string; frontBytes: Buffer }> {
  const started = await startApplication(app, freshApplicant(), freshIp());
  const { applicationId, accessToken } = started.json<{ applicationId: string; accessToken: string }>();
  applicationIds.push(applicationId);
  const frontBytes = markedJpeg();
  expect((await uploadSide(app, accessToken, "FRONT", frontBytes, "image/jpeg", freshIp())).statusCode).toBe(201);
  expect((await uploadSide(app, accessToken, "BACK", samplePng(), "image/png", freshIp())).statusCode).toBe(201);
  expect((await app.inject({ method: "POST", url: "/v1/public/applications/current/submit", remoteAddress: freshIp(), headers: { "x-application-token": accessToken } })).statusCode).toBe(202);
  expect((await app.inject({ method: "POST", url: `/v1/tenant-applications/${applicationId}/start-review`, headers: bearer(staff.officer.token) })).statusCode).toBe(200);
  const front = await platformDb.applicationDocument.findFirstOrThrow({ where: { applicationId, side: "FRONT" } });
  return { id: applicationId, token: accessToken, frontId: front.id, frontBytes };
}

function grant(id: string, documentId: string, token: string) {
  return app.inject({ method: "POST", url: `/v1/tenant-applications/${id}/documents/${documentId}/view-grant`, remoteAddress: freshIp(), headers: bearer(token) });
}

function view(viewToken: string, token: string) {
  return app.inject({ method: "GET", url: `/v1/tenant-applications/documents/view/${viewToken}`, headers: bearer(token) });
}

describe("upload validates the CONTENT", () => {
  it.each([
    ["a text file labelled as a JPEG", Buffer.from("This is not a picture of an ID card. ".repeat(60)), "image/jpeg", /none of them/],
    ["a JPEG labelled as a PNG", sampleJpeg(), "image/png", /does not match its declared type/],
    ["a truncated JPEG (no end marker)", sampleJpeg().subarray(0, 1800), "image/jpeg", /incomplete or damaged/],
    ["a file too small to be a scan", sampleJpeg(200), "image/jpeg", /too small/],
    ["a PDF with JavaScript", samplePdf("/OpenAction << /S /JavaScript /JS (app.alert(1)) >>"), "application/pdf", /active content/],
    ["a PDF carrying a script (polyglot)", samplePdf("<script>alert(1)</script>"), "application/pdf", /never does/],
    ["a PDF carrying HTML (polyglot)", samplePdf("<html><body>hi</body></html>"), "application/pdf", /never does/],
    ["a PDF carrying a server-page tag (polyglot)", samplePdf("<% run %>"), "application/pdf", /never does/],
    ["a mislabelled PDF (declared as a JPEG)", samplePdf(), "image/jpeg", /does not match its declared type/],
  ])("refuses %s", async (_label, bytes, type, message) => {
    const { token, id } = await draft();
    const response = await uploadSide(app, token, "FRONT", bytes, type, freshIp());
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toMatch(message);
    expect(await platformDb.applicationDocument.count({ where: { applicationId: id } })).toBe(0);
  });

  it("refuses a file over the size limit, and a type that is not an image or PDF", async () => {
    const { token } = await draft();
    const huge = sampleJpeg(5 * 1024 * 1024 + 4096);
    expect([400, 413]).toContain((await uploadSide(app, token, "FRONT", huge, "image/jpeg", freshIp())).statusCode);
    expect((await uploadSide(app, token, "FRONT", Buffer.from("GIF89a"), "image/gif", freshIp())).statusCode).toBe(415);
  });

  it.each([
    ["a JPEG whose bytes happen to contain \"<%\"", withBytes(sampleJpeg(3000), "<%=", 300), "image/jpeg"],
    ["a JPEG whose bytes happen to contain \"<script\"", withBytes(sampleJpeg(3000), "<script>", 300), "image/jpeg"],
    ["a PNG whose bytes happen to contain \"<%\" and \"<html\"", withBytes(withBytes(samplePng(3000), "<%", 200), "<html", 600), "image/png"],
  ])("accepts %s: an image is not scanned for markup", async (_label, bytes, type) => {
    const { token, id } = await draft();
    const response = await uploadSide(app, token, "FRONT", bytes, type, freshIp());
    expect(response.statusCode).toBe(201);
    expect(await platformDb.applicationDocument.count({ where: { applicationId: id, side: "FRONT" } })).toBe(1);
  });

  it("accepts a plain PDF scan, and replaces a side on re-upload", async () => {
    const { token, id } = await draft();
    expect((await uploadSide(app, token, "FRONT", samplePdf(), "application/pdf", freshIp())).statusCode).toBe(201);
    expect((await uploadSide(app, token, "FRONT", sampleJpeg(), "image/jpeg", freshIp())).statusCode).toBe(201);
    const docs = await platformDb.applicationDocument.findMany({ where: { applicationId: id } });
    expect(docs).toHaveLength(1);
    expect(docs[0]?.contentType).toBe("image/jpeg");
  });
});

describe("stored encrypted, exposed nowhere", () => {
  it("the database row holds ciphertext, never the plaintext", async () => {
    const { frontId, frontBytes } = await underReview();
    const row = await platformDb.applicationDocument.findUniqueOrThrow({ where: { id: frontId } });
    expect(row.ciphertext).not.toBeNull();
    expect(row.ciphertext).not.toContain(frontBytes.toString("base64").slice(0, 40));
    expect(Buffer.from(row.ciphertext ?? "", "base64").includes(Buffer.from(SENTINEL))).toBe(false);
    expect(row.keyRef).toBe("app-v1");
  });

  it("no ordinary response — the staff view or the applicant's status page — carries the document", async () => {
    const { id, token, frontBytes } = await underReview();
    const review = await app.inject({ method: "GET", url: `/v1/tenant-applications/${id}`, headers: bearer(staff.superAdmin.token) });
    const status = await applicationStatus(app, token, freshIp());
    for (const body of [review.body, status.body]) {
      expect(body).not.toContain(SENTINEL);
      expect(body).not.toContain(frontBytes.toString("base64").slice(0, 40));
      expect(body).not.toMatch(/ciphertext|authTag|sha256/);
    }
    expect(review.json<{ documents: Array<{ side: string }> }>().documents.map((d) => d.side).sort()).toEqual(["BACK", "FRONT"]);
  });

  it("there is no public path to a document", async () => {
    const { token, frontId } = await underReview();
    for (const url of ["/v1/public/applications/current/documents/FRONT", `/v1/public/documents/${frontId}`, `/uploads/${frontId}`, `/v1/tenant-applications/documents/${frontId}`]) {
      const response = await app.inject({ method: "GET", url, headers: { "x-application-token": token } });
      expect(response.statusCode, url).toBe(404);
      expect(response.body).not.toContain(SENTINEL);
    }
  });

  it("neither the upload nor a view writes the document, the token or the view grant to a log line", async () => {
    const { output, result } = await captureOutput(async () => {
      const reviewing = await underReview();
      const issued = await grant(reviewing.id, reviewing.frontId, staff.superAdmin.token);
      const viewToken = issued.json<{ token: string }>().token;
      await view(viewToken, staff.superAdmin.token);
      return { ...reviewing, viewToken };
    });
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain(result.frontBytes.toString("base64").slice(0, 40));
    expect(output).not.toContain(result.token);
    expect(output).not.toContain(result.viewToken);
  });
});

describe("who may see it", () => {
  it("a SUPER_ADMIN and the reviewing officer may; another officer, a mentor and business staff may not", async () => {
    const { id, frontId } = await underReview();
    expect((await grant(id, frontId, staff.superAdmin.token)).statusCode).toBe(200);
    expect((await grant(id, frontId, staff.officer.token)).statusCode).toBe(200);
    expect((await grant(id, frontId, otherOfficer.token)).statusCode).toBe(403);
    expect((await grant(id, frontId, mentor.token)).statusCode).toBe(403);
    expect((await grant(id, frontId, await accessTokenFor(app, owner))).statusCode).toBe(403);
  });

  it("a view grant opens the file ONCE, for its holder only, within its window — and both steps are audited", async () => {
    const { id, frontId, frontBytes } = await underReview();
    const issued = await grant(id, frontId, staff.superAdmin.token);
    expect(issued.headers["cache-control"]).toBe("no-store");
    const viewToken = issued.json<{ token: string }>().token;
    // Someone else holding the token gets nothing.
    expect((await view(viewToken, staff.officer.token)).statusCode).toBe(404);
    const opened = await view(viewToken, staff.superAdmin.token);
    expect(opened.statusCode).toBe(200);
    expect(opened.headers["content-type"]).toBe("image/jpeg");
    expect(opened.headers["cache-control"]).toBe("no-store, private");
    expect(opened.headers["content-security-policy"]).toContain("sandbox");
    expect(Buffer.from(opened.rawPayload).equals(frontBytes)).toBe(true);
    expect((await view(viewToken, staff.superAdmin.token)).statusCode).toBe(404);

    const late = await grant(id, frontId, staff.superAdmin.token);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect((await view(late.json<{ token: string }>().token, staff.superAdmin.token)).statusCode).toBe(404);
    vi.useRealTimers();

    const audits = await platformDb.auditLog.findMany({ where: { action: "APPLICATION_DOCUMENT_VIEWED", metadata: { path: ["documentId"], equals: frontId } } });
    expect(audits.map((a) => (a.metadata as { step: string }).step).sort()).toEqual(["grant", "grant", "view"]);
  });
});

describe("the database guarantees, attacked from raw SQL", () => {
  it("refuses adding, deleting or rewriting a document once the application is submitted (control: the purge)", async () => {
    const { id, frontId } = await underReview();
    await withPlatformTx(async (client) => {
      await expectDbRefusal(
        client.query(
          `INSERT INTO public.application_documents ("id","applicationId","kind","side","contentType","byteSize","sha256","ciphertext","iv","authTag","keyRef")
           VALUES (gen_random_uuid()::text, $1, 'NATIONAL_ID', 'FRONT', 'image/jpeg', 2048, repeat('a',64), 'x','y','z','app-v1')`,
          [id],
        ),
        { fn: "application_document_guard", message: /only while the applicant may edit/ },
      );
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`DELETE FROM public.application_documents WHERE "id" = $1`, [frontId]), { fn: "application_document_guard", message: /kept until the retention purge/ });
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.application_documents SET "ciphertext" = 'tampered' WHERE "id" = $1`, [frontId]), {
        fn: "application_document_guard",
        message: /only permitted change is the retention purge/,
      });
    });
    await withPlatformTx(async (client) => {
      await client.query(`UPDATE public.application_documents SET "purgedAt" = now(), "ciphertext" = NULL, "iv" = NULL, "authTag" = NULL, "keyRef" = NULL WHERE "id" = $1`, [frontId]);
    });
  });

  it("refuses a comprehensive application moved to SUBMITTED without both ID sides", async () => {
    const { id } = await draft();
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.tenant_applications SET "status" = 'SUBMITTED' WHERE "id" = $1`, [id]), {
        fn: "tenant_application_guard",
        message: /without the owner's ID document/,
      });
    });
  });

  it("refuses a view grant longer than five minutes, or re-used", async () => {
    const { frontId } = await underReview();
    await withPlatformTx(async (client) => {
      await expectDbRefusal(
        client.query(`INSERT INTO public.application_document_views ("id","documentId","userId","tokenHash","expiresAt") VALUES (gen_random_uuid()::text, $1, 'u', repeat('b',64), now() + interval '1 hour')`, [frontId]),
        { constraint: "application_document_view_short_lived", code: "23514" },
      );
    });
  });
});

describe("retention", () => {
  it("purges documents of applications decided long ago, keeping a stub; viewing then refuses; idempotent", async () => {
    const { id, frontId } = await underReview();
    await app.inject({ method: "POST", url: `/v1/tenant-applications/${id}/reject`, headers: bearer(staff.superAdmin.token), payload: { reason: "Testing retention." } });
    const later = new Date(Date.now() + (RETAIN_AFTER_DECISION_DAYS + 1) * 86_400_000);
    const first = await purgeExpiredDocuments(later);
    expect(first.purged).toBeGreaterThanOrEqual(2);
    const row = await platformDb.applicationDocument.findUniqueOrThrow({ where: { id: frontId } });
    expect(row).toMatchObject({ ciphertext: null, iv: null, authTag: null, keyRef: null });
    expect(row.purgedAt).not.toBeNull();
    expect((await grant(id, frontId, staff.superAdmin.token)).statusCode).toBe(409);
    expect(await platformDb.tenantApplicationEvent.count({ where: { applicationId: id, kind: "DOCUMENTS_PURGED" } })).toBe(1);
    const second = await purgeExpiredDocuments(later);
    expect(await platformDb.applicationDocument.count({ where: { applicationId: id, purgedAt: null } })).toBe(0);
    expect(second.purged).toBe(0);
  });

  it("a recently decided application keeps its document", async () => {
    const reviewing = await applyFully(app, freshApplicant(), freshIp);
    applicationIds.push(reviewing.id);
    await purgeExpiredDocuments(new Date());
    expect(await platformDb.applicationDocument.count({ where: { applicationId: reviewing.id, purgedAt: null } })).toBe(2);
  });
});
