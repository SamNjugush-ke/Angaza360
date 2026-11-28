// ===========================================================================
// INVARIANT: the mentorship gate's cross-tenant read CANNOT WRITE — enforced by
// PostgreSQL, not by the callers' good behaviour (the engineering ledger "Mentorship", Task 14.1).
//
// A mentee tenant is provisioned, an admin invites a mentor, the business's owner
// consents (all through the real engagement service), and then — INSIDE
// withEngagedTenant — writes are attempted through the very reader the gate hands
// out. Each must fail with SQLSTATE 25006 (read_only_sql_transaction), and the
// mentee's schema must be unchanged afterwards. A read through the same gate is the
// control that proves the gate opened.
//
// Mentorship history is append-only by design, so this file's afterAll removes its
// tenant with the teardown-only purgeMentoredTenant helper (test database only).
// ===========================================================================

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { pool } from "../../src/db/pool";
import { withEngagedTenant } from "../../src/services/mentorship/access";
import {
  MentorshipNotFoundError,
  consentToEngagement,
  createEngagement,
  type MentorshipActor,
} from "../../src/services/mentorship/engagements";
import type { UserRole } from "../../src/generated/platform/enums";
import {
  dropTenant,
  provisionFixture,
  purgeMentoredTenant,
  schemaOf,
  tenantIdOf,
} from "../setup/tenant";
import { sqlStateOf } from "../support/db-errors";

const MENTEE_SUBDOMAIN = "qa-mentee";
const schema = schemaOf(MENTEE_SUBDOMAIN);
const createdUsers: string[] = [];
let mentor: MentorshipActor;
let engagementId = "";

async function createUser(role: UserRole, tenantId: string | null): Promise<MentorshipActor> {
  const user = await platformDb.user.create({
    data: {
      email: `qa-${role.toLowerCase()}-${randomUUID().slice(0, 8)}@test.invalid`,
      fullName: `QA ${role}`,
      role,
      tenantId,
    },
  });
  createdUsers.push(user.id);
  return { userId: user.id, role: user.role, tenantId: user.tenantId };
}

async function customerCount(): Promise<number> {
  const result = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${schema}".customers`);
  return Number.parseInt(result.rows[0]?.n ?? "-1", 10);
}

beforeAll(async () => {
  await purgeMentoredTenant(MENTEE_SUBDOMAIN, []);
  await dropTenant(MENTEE_SUBDOMAIN);
  await provisionFixture(MENTEE_SUBDOMAIN, "QA Mentee Business");
  const tenantId = await tenantIdOf(MENTEE_SUBDOMAIN);
  const admin = await createUser("SUPER_ADMIN", null);
  mentor = await createUser("MENTOR", null);
  const owner = await createUser("MSME_OWNER", tenantId);
  const invited = await createEngagement(admin, { mentorId: mentor.userId, tenantId });
  const active = await consentToEngagement(owner, invited.id);
  expect(active.status).toBe("ACTIVE");
  engagementId = active.id;
});

afterAll(async () => {
  await purgeMentoredTenant(MENTEE_SUBDOMAIN, createdUsers);
});

describe("mentorship gate: the engaged read is READ ONLY", () => {
  it("control: the gate opens for the consenting engagement and a READ succeeds", async () => {
    const result = await withEngagedTenant(mentor.userId, engagementId, "t-a1:read", (source) =>
      source.reader.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${source.schema}".accounts`),
    );
    expect(result[0]?.n).toBeGreaterThan(0n);
  });

  it.each([
    ["INSERT", (s: string) => `INSERT INTO "${s}".customers ("id", "name", "updatedAt") VALUES ('${randomUUID()}', 'mentor write', now()) RETURNING "id"`],
    ["UPDATE", (s: string) => `UPDATE "${s}".accounts SET "name" = "name" || ' (mentored)' RETURNING "id"`],
    ["DELETE", (s: string) => `DELETE FROM "${s}".customers RETURNING "id"`],
  ])("a %s attempted through the gate is refused by PostgreSQL with SQLSTATE 25006", async (_verb, statement) => {
    const before = await customerCount();
    let caught: unknown = undefined;
    try {
      await withEngagedTenant(mentor.userId, engagementId, "t-a1:write-attempt", (source) =>
        source.reader.$queryRawUnsafe(statement(source.schema)),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught, "the write must not be accepted").toBeDefined();
    expect(sqlStateOf(caught)).toBe("25006");
    expect(await customerCount()).toBe(before);
  });

  it("the attempted writes left the mentee's schema unchanged", async () => {
    expect(await customerCount()).toBe(0);
    const renamed = await pool.query(`SELECT 1 FROM "${schema}".accounts WHERE "name" LIKE '%(mentored)'`);
    expect(renamed.rowCount).toBe(0);
  });

  it("the gate admits no one else: another mentor, or a tenant id passed as the engagement, is not found", async () => {
    const stranger = await createUser("MENTOR", null);
    await expect(
      withEngagedTenant(stranger.userId, engagementId, "t-a1:stranger", async () => 1),
    ).rejects.toBeInstanceOf(MentorshipNotFoundError);
    await expect(
      withEngagedTenant(mentor.userId, await tenantIdOf(MENTEE_SUBDOMAIN), "t-a1:tenant-as-engagement", async () => 1),
    ).rejects.toBeInstanceOf(MentorshipNotFoundError);
  });
});
