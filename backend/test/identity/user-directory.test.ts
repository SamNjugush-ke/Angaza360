// T-B-ADMIN-USER-LIST: the platform user directory (GET /v1/users/directory) — platform staff only,
// searchable, filterable, paged by a total order — and names on the identity audit log.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { buildServer } from "../../src/server";
import { tenantIdOf } from "../setup/tenant";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "./staff-fixture";

let app: FastifyInstance;
let admin: SignedIn;
let officer: SignedIn;
let owner: SignedIn;
let cashier: SignedIn;
const made: StaffUser[] = [];
const tag = `dir${randomUUID().slice(0, 6)}`;

interface Row {
  id: string;
  fullName: string;
  role: string;
  tenantId: string | null;
  businessName: string | null;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  const tenant = await tenantIdOf();
  const mk = async (role: Parameters<typeof createStaffUser>[0], tenantId: string | null) => {
    const user = await createStaffUser(role, tenantId);
    made.push(user);
    return user;
  };
  admin = await signIn(app, await mk("SUPER_ADMIN", null));
  officer = await signIn(app, await mk("PROGRAM_OFFICER", null));
  owner = await signIn(app, await mk("MSME_OWNER", tenant));
  cashier = await signIn(app, await mk("CASHIER", tenant));
  for (const name of ["Alpha", "Bravo", "Charlie"]) {
    const mentor = await mk("MENTOR", null);
    await platformDb.user.update({ where: { id: mentor.id }, data: { fullName: `${tag} Mentor ${name}` } });
  }
});

afterAll(async () => {
  await platformDb.user.deleteMany({ where: { id: { in: made.map((u) => u.id) } } });
  await app.close();
});

const directory = (token: string, query: string) => app.inject({ method: "GET", url: `/v1/users/directory?${query}`, headers: bearer(token) });

describe("the platform user directory", () => {
  it("lists and searches users for a SUPER_ADMIN, with each business's name", async () => {
    const found = await directory(admin.token, `q=${tag}`);
    expect(found.statusCode).toBe(200);
    const body = found.json<{ data: Row[]; total: number }>();
    expect(body.total).toBe(3);
    expect(body.data.map((r) => r.fullName)).toEqual([`${tag} Mentor Alpha`, `${tag} Mentor Bravo`, `${tag} Mentor Charlie`]);
    expect(body.data.every((r) => r.role === "MENTOR" && r.tenantId === null && r.businessName === null)).toBe(true);

    const mine = (await directory(admin.token, `tenantId=${encodeURIComponent((await tenantIdOf()))}&role=CASHIER`)).json<{ data: Row[] }>();
    expect(mine.data.some((r) => r.id === cashier.user.id && r.businessName === "QA Fixture Business")).toBe(true);
  });

  it("pages by a total order, so pages never overlap", async () => {
    const first = (await directory(admin.token, `q=${tag}&take=2&skip=0`)).json<{ data: Row[]; total: number }>();
    const second = (await directory(admin.token, `q=${tag}&take=2&skip=2`)).json<{ data: Row[]; total: number }>();
    expect(first.total).toBe(3);
    expect([...first.data, ...second.data].map((r) => r.fullName)).toEqual([`${tag} Mentor Alpha`, `${tag} Mentor Bravo`, `${tag} Mentor Charlie`]);
  });

  it("is readable by a programme officer (the mentor picker) and by no business user", async () => {
    const mentors = await directory(officer.token, `role=MENTOR&q=${tag}`);
    expect(mentors.statusCode).toBe(200);
    expect(mentors.json<{ total: number }>().total).toBe(3);
    expect((await directory(owner.token, "")).statusCode).toBe(403);
    expect((await directory(cashier.token, "")).statusCode).toBe(403);
    // A programme officer reads; changing a user stays the SUPER_ADMIN's.
    const change = await app.inject({ method: "PATCH", url: `/v1/users/${cashier.user.id}/role`, headers: bearer(officer.token), payload: { role: "VIEWER_AUDITOR" } });
    expect(change.statusCode).toBe(403);
  });
});

describe("names on the identity audit log", () => {
  it("names the actor and the target of each entry", async () => {
    const changed = await app.inject({ method: "PATCH", url: `/v1/users/${cashier.user.id}/role`, headers: bearer(owner.token), payload: { role: "WAREHOUSE_STAFF" } });
    expect(changed.statusCode).toBe(200);
    const audit = await app.inject({ method: "GET", url: "/v1/users/audit?limit=5", headers: bearer(owner.token) });
    const entry = audit.json<{ data: Array<{ action: string; actorUserId: string; targetUserId: string; actorName: string | null; targetName: string | null }> }>().data.find((e) => e.action === "ROLE_CHANGED" && e.targetUserId === cashier.user.id);
    expect(entry).toMatchObject({ actorUserId: owner.user.id, actorName: "QA MSME_OWNER", targetName: "QA CASHIER" });
  });
});

describe("the business name on /me (T-B-ME-NAME)", () => {
  it("names the business of a business user, and has no business for a platform user", async () => {
    const mine = await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(owner.token) });
    expect(mine.json<{ tenant: { name: string } | null }>().tenant?.name).toBe("QA Fixture Business");
    const platform = await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(admin.token) });
    expect(platform.json<{ tenant: unknown }>().tenant).toBeNull();
  });
});
