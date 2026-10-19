// ===========================================================================
// BATCH CSV ONBOARDING (Task T-A6.3): validate -> preview -> commit.
//
// * The template is the CSV header; a file-level problem stores nothing.
// * A MIXED upload previews each row correctly: GREEN; a duplicate of an existing tenant;
//   a malformed field; and a WITHIN-FILE duplicate (both rows flagged). Nothing is
//   provisioned by an upload.
// * THE BATCH GREEN-GATE (binding): commit is refused while ANY row is not green.
// * Correcting and removing rows turns the batch all-green; commit then provisions and
//   invites EACH row, marks the batch COMMITTED, and audits; re-committing provisions
//   nothing new. A committed batch is final (service and guard).
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { buildServer } from "../../src/server";
import { csvLine } from "../../src/services/csv/parse";
import { ONBOARDING_CSV_SCHEMA } from "../../src/services/tenants/batch";
import { expectDbRefusal } from "../support/db-errors";
import { withPlatformTx } from "../support/platform-tx";
import { freshIp } from "../security/http-app";
import { bearer } from "../identity/staff-fixture";
import { cleanUp, freshCandidate, freshKraPin, platformStaff, type Candidate, type PlatformStaff } from "./onboarding-fixture";

const COLUMNS = ONBOARDING_CSV_SCHEMA.columns.map((column) => column.name);

let app: FastifyInstance;
let staff: PlatformStaff;
const provisioned: string[] = [];
const batchIds: string[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  staff = await platformStaff(app);
});

afterAll(async () => {
  await platformDb.tenantApplication.deleteMany({ where: { batchId: { in: batchIds }, status: "PENDING_APPROVAL" } });
  await cleanUp(provisioned, staff.users);
  await app.close();
});

function toCsv(rows: readonly Candidate[]): string {
  const lines = [csvLine(COLUMNS)];
  for (const row of rows) {
    const record: Record<string, string | null | undefined> = { ...row };
    lines.push(csvLine(COLUMNS.map((column) => record[column] ?? "")));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function upload(csv: string, token: string = staff.officer.token) {
  return app.inject({
    method: "POST",
    url: "/v1/tenant-applications/batch",
    remoteAddress: freshIp(),
    headers: { ...bearer(token), "content-type": "text/csv" },
    payload: csv,
  });
}

interface PreviewBody {
  batch: { id: string; status: string };
  allGreen: boolean;
  rows: Array<{
    application: { id: string; batchRowNumber: number; businessName: string };
    status: string;
    errors: Array<{ field: string; code: string }>;
    proposedSubdomain: string | null;
  }>;
}

function commit(batchId: string, token: string = staff.superAdmin.token) {
  return app.inject({ method: "POST", url: `/v1/tenant-applications/batch/${batchId}/commit`, remoteAddress: freshIp(), headers: bearer(token) });
}

describe("the template and file-level validation", () => {
  it("GET /batch/template is a text/csv header naming every column", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/tenant-applications/batch/template", headers: bearer(staff.officer.token) });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/csv/);
    expect(response.body).toBe(`${COLUMNS.join(",")}\r\n`);
  });

  it("an unknown or missing column is a 400 and stores nothing", async () => {
    const before = await platformDb.onboardingBatch.count();
    const unknown = await upload("businessName,colour\nx,red\n");
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ message: string }>().message).toMatch(/Unknown column/);
    const missing = await upload("businessName\nx\n");
    expect(missing.json<{ message: string }>().message).toMatch(/Missing required column\(s\): taxRegime, ownerFullName, ownerEmail/);
    expect(await platformDb.onboardingBatch.count()).toBe(before);
  });
});

describe("a mixed upload, its preview, the green-gate and the commit", () => {
  let batchId = "";
  let preview: PreviewBody;
  const green = freshCandidate();
  const duplicateOfTenant = freshCandidate({ businessName: "QA Fixture Business" });
  const malformed = freshCandidate({ kraPin: "BAD-PIN" });
  const sharedPin = freshKraPin();
  const twinA = freshCandidate({ kraPin: sharedPin });
  const twinB = freshCandidate({ kraPin: sharedPin });

  it("previews every row correctly — and provisions nothing", async () => {
    const tenantsBefore = await platformDb.tenant.count();
    const response = await upload(toCsv([green, duplicateOfTenant, malformed, twinA, twinB]));
    expect(response.statusCode, response.body).toBe(201);
    preview = response.json<PreviewBody>();
    batchId = preview.batch.id;
    batchIds.push(batchId);
    expect(preview.batch.status).toBe("PREVIEW");
    expect(preview.allGreen).toBe(false);
    const byRow = new Map(preview.rows.map((row) => [row.application.batchRowNumber, row]));
    expect(byRow.get(1)).toMatchObject({ status: "GREEN", errors: [] });
    expect(byRow.get(2)).toMatchObject({ status: "RED", errors: [{ field: "businessName", code: "DUPLICATE" }] });
    expect(byRow.get(3)).toMatchObject({ status: "RED", errors: [{ field: "kraPin", code: "FORMAT" }] });
    // The within-file duplicate flags BOTH rows.
    expect(byRow.get(4)).toMatchObject({ status: "RED", errors: [{ field: "kraPin", code: "DUPLICATE" }] });
    expect(byRow.get(5)).toMatchObject({ status: "RED", errors: [{ field: "kraPin", code: "DUPLICATE" }] });
    expect(await platformDb.tenant.count()).toBe(tenantsBefore);
    expect(await platformDb.tenantApplication.count({ where: { batchId, source: "BATCH", status: "PENDING_APPROVAL" } })).toBe(5);
  });

  it("THE BATCH GREEN-GATE: commit is refused while any row is not green, and nothing is provisioned", async () => {
    const tenantsBefore = await platformDb.tenant.count();
    const response = await commit(batchId);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toMatch(/cannot be committed while any row is not green: row 2 \(businessName\); row 3 \(kraPin\); row 4 \(kraPin\); row 5 \(kraPin\)/);
    expect(await platformDb.tenant.count()).toBe(tenantsBefore);
    expect((await platformDb.onboardingBatch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("PREVIEW");
  });

  it("correcting and removing rows turns the batch all-green", async () => {
    const id = (row: number) => preview.rows.find((r) => r.application.batchRowNumber === row)?.application.id ?? "";
    const headers = bearer(staff.officer.token);
    const fixedName = await app.inject({ method: "PATCH", url: `/v1/tenant-applications/${id(2)}`, headers, payload: { businessName: `${green.businessName} Two` } });
    expect(fixedName.json()).toMatchObject({ status: "GREEN" });
    const fixedPin = await app.inject({ method: "PATCH", url: `/v1/tenant-applications/${id(3)}`, headers, payload: { kraPin: freshKraPin() } });
    expect(fixedPin.json()).toMatchObject({ status: "GREEN" });
    expect((await app.inject({ method: "DELETE", url: `/v1/tenant-applications/${id(5)}`, headers })).statusCode).toBe(204);

    const now = await app.inject({ method: "GET", url: `/v1/tenant-applications/batch/${batchId}`, headers });
    const body = now.json<PreviewBody>();
    expect(body.rows).toHaveLength(4);
    expect(body.allGreen).toBe(true);
    // Proposed subdomains never collide within the file.
    const subdomains = body.rows.map((row) => row.proposedSubdomain);
    expect(new Set(subdomains).size).toBe(subdomains.length);
  });

  it("a PROGRAM_OFFICER cannot commit; a SUPER_ADMIN commit provisions and invites EACH row", async () => {
    expect((await commit(batchId, staff.officer.token)).statusCode).toBe(403);

    const response = await commit(batchId);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ batch: { status: string }; alreadyCommitted: boolean; onboarded: Array<{ tenant: { id: string; subdomain: string; name: string } }> }>();
    for (const entry of body.onboarded) provisioned.push(entry.tenant.subdomain);
    expect(body.batch.status).toBe("COMMITTED");
    expect(body.alreadyCommitted).toBe(false);
    expect(body.onboarded).toHaveLength(4);

    const rows = await platformDb.tenantApplication.findMany({ where: { batchId } });
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.status === "APPROVED" && row.resultingTenantId !== null)).toBe(true);
    for (const row of rows) {
      const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: row.resultingTenantId ?? "" } });
      expect(tenant).toMatchObject({ status: "ACTIVE", name: row.businessName });
      expect(await platformDb.userInvitation.count({ where: { email: row.ownerEmail, role: "MSME_OWNER", tenantId: tenant.id, status: "PENDING" } })).toBe(1);
      expect(await platformDb.auditLog.count({ where: { action: "TENANT_ONBOARDED", tenantId: tenant.id, metadata: { path: ["source"], equals: "BATCH" } } })).toBe(1);
    }
    expect(await platformDb.auditLog.count({ where: { action: "BATCH_COMMITTED", metadata: { path: ["batchId"], equals: batchId } } })).toBe(1);
  });

  it("re-committing provisions nothing new; a committed batch is final (service and guard)", async () => {
    const tenantsBefore = await platformDb.tenant.count();
    const again = await commit(batchId);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ alreadyCommitted: true, onboarded: [] });
    expect(await platformDb.tenant.count()).toBe(tenantsBefore);

    const rowId = (await platformDb.tenantApplication.findFirstOrThrow({ where: { batchId } })).id;
    const edit = await app.inject({ method: "PATCH", url: `/v1/tenant-applications/${rowId}`, headers: bearer(staff.officer.token), payload: { sector: "Changed" } });
    expect(edit.statusCode).toBe(409);

    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.onboarding_batches SET "status" = 'PREVIEW', "committedAt" = NULL WHERE "id" = $1`, [batchId]), {
        fn: "onboarding_batch_guard",
        message: /COMMITTED, which is final/,
      });
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`DELETE FROM public.onboarding_batches WHERE "id" = $1`, [batchId]), {
        fn: "onboarding_batch_guard",
      });
    });
  });
});
