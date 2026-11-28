// ===========================================================================
// PLATFORM REPORTS (M4.5 W4) — the platform half of the curated library, for SUPER_ADMIN and
// PROGRAM_OFFICER. They read PLATFORM data only — the tenant registry, applications, users, the
// identity audit log, notification delivery, the integration-health mirror, mentorship and donor
// records. A business's own books are NEVER read here, with one sanctioned exception: the donor
// cohort report reads each CONSENTED member's figures through the existing consented, logged,
// READ ONLY gate (`buildCohortAggregate`) — the same numbers the donor screen shows, never a new
// cross-schema query. Identity data is minimised: a National ID or an ID document never appears.
// ===========================================================================

import type { Prisma, UserRole } from "../../generated/platform/client";
import { platformDb } from "../../db/platform";
import { businessDateOf } from "../../lib/business-time";
import { buildCohortAggregate } from "../donor/aggregate";
import { ANGAZA_BRAND, type Row } from "../export/model";
import { isoDay } from "../export/values";
import {
  applied,
  bounded,
  businessWindow,
  doc,
  enumFilter,
  intFilter,
  matches,
  PERIOD_FILTERS,
  periodFilter,
  periodOf,
  ReportFilterError,
  textFilter,
  type PlatformReport,
} from "./library";

const STAFF: UserRole[] = ["SUPER_ADMIN", "PROGRAM_OFFICER"];
const SUPER: UserRole[] = ["SUPER_ADMIN"];

const TENANT_STATUSES = ["PENDING_PROVISIONING", "ACTIVE", "SUSPENDED", "DEACTIVATED"] as const;
const TIERS = ["MWANZO", "UKUAJI", "BIASHARA", "MSTAWI", "ENTERPRISE"] as const;
const words = (value: string) => value.replace(/_/g, " ").toLowerCase();

const businesses: PlatformReport = {
  id: "businesses",
  title: "Businesses",
  description: "Every business on the platform with its status, plan, county, sector and structure.",
  category: "platform",
  roles: STAFF,
  sensitive: false,
  filters: [
    { key: "status", label: "Status", type: "select", options: TENANT_STATUSES.map((s) => ({ value: s, label: words(s) })) },
    { key: "tier", label: "Plan", type: "select", options: TIERS.map((t) => ({ value: t, label: t.toLowerCase() })) },
    { key: "county", label: "County", type: "search" },
    { key: "sector", label: "Sector", type: "search" },
    { key: "q", label: "Name", type: "search" },
  ],
  async run(_context, query) {
    const status = enumFilter(query, "status", "Status", TENANT_STATUSES);
    const tier = enumFilter(query, "tier", "Plan", TIERS);
    const county = textFilter(query, "county");
    const sector = textFilter(query, "sector");
    const q = textFilter(query, "q");
    const tenants = await platformDb.tenant.findMany({
      where: { ...(status ? { status } : {}), ...(tier ? { subscriptionTier: tier } : {}), ...(county ? { county: { equals: county, mode: "insensitive" } } : {}), ...(sector ? { businessSector: { contains: sector, mode: "insensitive" } } : {}) },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 50_001,
    });
    const rows = tenants.filter((t) => matches(q, t.name, t.subdomain));
    return doc({
      reportId: "businesses",
      title: "Businesses",
      brand: ANGAZA_BRAND,
      period: null,
      filters: applied(["Status", status ? words(status) : undefined], ["Plan", tier?.toLowerCase()], ["County", county], ["Sector contains", sector], ["Name contains", q]),
      sections: [
        {
          name: "Businesses",
          columns: [
            { key: "name", header: "Business", kind: "text" },
            { key: "subdomain", header: "Subdomain", kind: "text", width: 20 },
            { key: "status", header: "Status", kind: "text", width: 12 },
            { key: "tier", header: "Plan", kind: "text", width: 10 },
            { key: "county", header: "County", kind: "text", width: 14 },
            { key: "sector", header: "Sector", kind: "text", width: 16 },
            { key: "structure", header: "Structure", kind: "text", width: 16 },
            { key: "regime", header: "Tax regime", kind: "text", width: 12 },
            { key: "created", header: "Joined", kind: "date" },
          ],
          rows: bounded(rows, "businesses").map((t) => ({ name: t.name, subdomain: t.subdomain, status: words(t.status), tier: t.subscriptionTier.toLowerCase(), county: t.county, sector: t.businessSector, structure: t.businessStructure ? words(t.businessStructure) : null, regime: words(t.taxRegime), created: isoDay(businessDateOf(t.createdAt)) })),
        },
      ],
    });
  },
};

/** Counts by a key, sorted by count then name. */
function grouped<T>(items: readonly T[], keyOf: (item: T) => string | null): Row[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item) ?? "Not recorded";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count: BigInt(count) }));
}

const breakdown: PlatformReport = {
  id: "businesses-breakdown",
  title: "Businesses by county, sector, plan and status",
  description: "How the platform's businesses spread across counties, sectors, plans and statuses.",
  category: "platform",
  roles: STAFF,
  sensitive: false,
  filters: [{ key: "status", label: "Status", type: "select", options: TENANT_STATUSES.map((s) => ({ value: s, label: words(s) })) }],
  async run(_context, query) {
    const status = enumFilter(query, "status", "Status", TENANT_STATUSES);
    const tenants = await platformDb.tenant.findMany({ where: status ? { status } : {}, select: { county: true, businessSector: true, subscriptionTier: true, status: true } });
    const section = (name: string, header: string, rows: Row[]) => ({ name, columns: [{ key: "key", header, kind: "text" as const }, { key: "count", header: "Businesses", kind: "integer" as const, total: true }], rows });
    return doc({
      reportId: "businesses-breakdown",
      title: "Businesses by county, sector, plan and status",
      brand: ANGAZA_BRAND,
      period: null,
      filters: applied(["Status", status ? words(status) : "Every status"]),
      sections: [
        section("By county", "County", grouped(tenants, (t) => t.county)),
        section("By sector", "Sector", grouped(tenants, (t) => t.businessSector)),
        section("By plan", "Plan", grouped(tenants, (t) => t.subscriptionTier.toLowerCase())),
        section("By status", "Status", grouped(tenants, (t) => words(t.status))),
      ],
    });
  },
};

const APPLICATION_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "NEEDS_CHANGES", "APPROVED", "REJECTED"] as const;

const applications: PlatformReport = {
  id: "applications",
  title: "Applications and outcomes",
  description: "Business applications submitted in the period, how far each has got, and the outcome.",
  category: "platform",
  roles: STAFF,
  sensitive: false,
  filters: [
    ...PERIOD_FILTERS,
    { key: "status", label: "Status", type: "select", options: APPLICATION_STATUSES.map((s) => ({ value: s, label: words(s) })) },
    { key: "source", label: "Came from", type: "select", options: [{ value: "SELF_SERVE", label: "Self sign-up" }, { value: "ADMIN", label: "Admin" }, { value: "BATCH", label: "Batch upload" }] },
    { key: "county", label: "County", type: "search" },
  ],
  async run(_context, query) {
    const period = periodFilter(query);
    const status = enumFilter(query, "status", "Status", APPLICATION_STATUSES);
    const source = enumFilter(query, "source", "Came from", ["SELF_SERVE", "ADMIN", "BATCH"] as const);
    const county = textFilter(query, "county");
    const { start, endExclusive } = businessWindow(period);
    const apps = await platformDb.tenantApplication.findMany({
      // A DRAFT is the applicant's unfinished form: never reported to staff.
      where: { status: status ?? { not: "DRAFT" }, submittedAt: { gte: start, lt: endExclusive }, ...(source ? { source } : {}), ...(county ? { county: { equals: county, mode: "insensitive" } } : {}) },
      select: { businessName: true, county: true, sector: true, source: true, status: true, submittedAt: true, reviewedAt: true, rejectionReason: true },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      take: 50_001,
    });
    return doc({
      reportId: "applications",
      title: "Applications and outcomes",
      brand: ANGAZA_BRAND,
      period: periodOf(period),
      filters: applied(["Status", status ? words(status) : "Every submitted application"], ["Came from", source ? words(source) : undefined], ["County", county]),
      sections: [
        {
          name: "Applications",
          columns: [
            { key: "business", header: "Business", kind: "text" },
            { key: "county", header: "County", kind: "text", width: 14 },
            { key: "sector", header: "Sector", kind: "text", width: 16 },
            { key: "source", header: "Came from", kind: "text", width: 12 },
            { key: "status", header: "Status", kind: "text", width: 14 },
            { key: "submitted", header: "Submitted", kind: "datetime" },
            { key: "decided", header: "Decided", kind: "datetime" },
            { key: "reason", header: "Reason (if rejected)", kind: "text", width: 30 },
          ],
          rows: bounded(apps, "applications").map((a) => ({ business: a.businessName, county: a.county, sector: a.sector, source: words(a.source), status: words(a.status), submitted: a.submittedAt, decided: a.status === "APPROVED" || a.status === "REJECTED" ? a.reviewedAt : null, reason: a.rejectionReason })),
        },
        { name: "By outcome", columns: [{ key: "key", header: "Status", kind: "text" }, { key: "count", header: "Applications", kind: "integer", total: true }], rows: grouped(apps, (a) => words(a.status)) },
      ],
    });
  },
};

const trends: PlatformReport = {
  id: "registration-trends",
  title: "Registration and activation trends",
  description: "Each month: applications submitted, approved and rejected, and businesses that joined.",
  category: "platform",
  roles: STAFF,
  sensitive: false,
  filters: [{ key: "months", label: "Months", type: "number", defaultHint: "12" }],
  async run(_context, query) {
    const months = intFilter(query, "months", "Months", 1, 36, 12);
    const today = businessDateOf(new Date());
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (months - 1), 1));
    const { start } = businessWindow({ from: first, to: first });
    const [apps, tenants] = await Promise.all([
      platformDb.tenantApplication.findMany({ where: { status: { not: "DRAFT" }, submittedAt: { gte: start } }, select: { submittedAt: true, reviewedAt: true, status: true } }),
      platformDb.tenant.findMany({ where: { createdAt: { gte: start } }, select: { createdAt: true } }),
    ]);
    const monthOf = (at: Date) => isoDay(businessDateOf(at)).slice(0, 7);
    const rows: Row[] = [];
    for (let i = 0; i < months; i += 1) {
      const m = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1)).toISOString().slice(0, 7);
      rows.push({
        month: m,
        submitted: BigInt(apps.filter((a) => monthOf(a.submittedAt) === m).length),
        approved: BigInt(apps.filter((a) => a.status === "APPROVED" && a.reviewedAt !== null && monthOf(a.reviewedAt) === m).length),
        rejected: BigInt(apps.filter((a) => a.status === "REJECTED" && a.reviewedAt !== null && monthOf(a.reviewedAt) === m).length),
        joined: BigInt(tenants.filter((t) => monthOf(t.createdAt) === m).length),
      });
    }
    return doc({
      reportId: "registration-trends",
      title: "Registration and activation trends",
      brand: ANGAZA_BRAND,
      period: { from: isoDay(first), to: isoDay(today) },
      filters: applied(["Months", months.toString()]),
      sections: [
        {
          name: "By month",
          columns: [
            { key: "month", header: "Month", kind: "text", width: 10 },
            { key: "submitted", header: "Applications submitted", kind: "integer", total: true },
            { key: "approved", header: "Approved", kind: "integer", total: true },
            { key: "rejected", header: "Rejected", kind: "integer", total: true },
            { key: "joined", header: "Businesses joined", kind: "integer", total: true },
          ],
          rows,
        },
      ],
    });
  },
};

const ROLES = ["SUPER_ADMIN", "PROGRAM_OFFICER", "MENTOR", "COACH", "MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "CASHIER", "WAREHOUSE_STAFF", "HR_OFFICER", "VIEWER_AUDITOR"] as const;

const users: PlatformReport = {
  id: "users",
  title: "Users and roles",
  description: "Every account with its role, business, whether it is active, and when it last signed in.",
  category: "platform",
  roles: STAFF,
  sensitive: true,
  filters: [
    { key: "role", label: "Role", type: "select", options: ROLES.map((r) => ({ value: r, label: words(r) })) },
    { key: "tenantId", label: "Business", type: "entity", entity: "tenant" },
    { key: "active", label: "Active", type: "select", options: [{ value: "true", label: "Active" }, { value: "false", label: "Deactivated" }] },
    { key: "q", label: "Name or email", type: "search" },
  ],
  async run(_context, query) {
    const role = enumFilter(query, "role", "Role", ROLES);
    const tenantId = textFilter(query, "tenantId");
    const active = enumFilter(query, "active", "Active", ["true", "false"] as const);
    const q = textFilter(query, "q");
    const list = await platformDb.user.findMany({
      where: { ...(role ? { role } : {}), ...(tenantId ? { tenantId } : {}), ...(active ? { isActive: active === "true" } : {}), ...(q ? { OR: [{ fullName: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}) },
      select: { fullName: true, email: true, role: true, isActive: true, lastLoginAt: true, createdAt: true, mfaEnabled: true, tenant: { select: { name: true } } },
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
      take: 50_001,
    });
    return doc({
      reportId: "users",
      title: "Users and roles",
      brand: ANGAZA_BRAND,
      period: null,
      filters: applied(["Role", role ? words(role) : undefined], ["Business", tenantId ? list[0]?.tenant?.name ?? tenantId : undefined], ["Active", active === undefined ? undefined : active === "true" ? "Active" : "Deactivated"], ["Name or email contains", q]),
      sections: [
        {
          name: "Users",
          columns: [
            { key: "name", header: "Name", kind: "text" },
            { key: "email", header: "Email", kind: "text", width: 28 },
            { key: "role", header: "Role", kind: "text", width: 16 },
            { key: "business", header: "Business", kind: "text", width: 22 },
            { key: "active", header: "Active", kind: "text", width: 8 },
            { key: "mfa", header: "Two-step", kind: "text", width: 9 },
            { key: "lastLogin", header: "Last sign-in", kind: "datetime" },
            { key: "created", header: "Created", kind: "date" },
          ],
          rows: bounded(list, "users").map((u) => ({ name: u.fullName, email: u.email, role: words(u.role), business: u.tenant?.name ?? "Platform", active: u.isActive ? "Yes" : "No", mfa: u.mfaEnabled ? "On" : "Off", lastLogin: u.lastLoginAt, created: isoDay(businessDateOf(u.createdAt)) })),
        },
        { name: "By role", columns: [{ key: "key", header: "Role", kind: "text" }, { key: "count", header: "Users", kind: "integer", total: true }], rows: grouped(list, (u) => words(u.role)) },
      ],
    });
  },
};

const adoption: PlatformReport = {
  id: "adoption",
  title: "Activity and adoption",
  description: "For each business: its staff accounts and how many signed in within the last 30 days.",
  category: "platform",
  roles: STAFF,
  sensitive: false,
  filters: [{ key: "status", label: "Business status", type: "select", options: TENANT_STATUSES.map((s) => ({ value: s, label: words(s) })) }],
  async run(_context, query) {
    const status = enumFilter(query, "status", "Business status", TENANT_STATUSES);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const tenants = await platformDb.tenant.findMany({
      where: status ? { status } : {},
      select: { name: true, status: true, subscriptionTier: true, createdAt: true, users: { select: { isActive: true, lastLoginAt: true } } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 50_001,
    });
    return doc({
      reportId: "adoption",
      title: "Activity and adoption",
      brand: ANGAZA_BRAND,
      period: null,
      filters: applied(["Business status", status ? words(status) : undefined], ["Active means", "signed in within the last 30 days"]),
      sections: [
        {
          name: "Adoption",
          note: "From sign-in records only: a business's books are not read for this report.",
          columns: [
            { key: "name", header: "Business", kind: "text" },
            { key: "status", header: "Status", kind: "text", width: 12 },
            { key: "tier", header: "Plan", kind: "text", width: 10 },
            { key: "accounts", header: "Active accounts", kind: "integer", total: true },
            { key: "recent", header: "Signed in, last 30 days", kind: "integer", total: true },
            { key: "last", header: "Last sign-in", kind: "datetime" },
          ],
          rows: bounded(tenants, "businesses").map((t) => {
            const active = t.users.filter((u) => u.isActive);
            const last = active.map((u) => u.lastLoginAt).filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
            return { name: t.name, status: words(t.status), tier: t.subscriptionTier.toLowerCase(), accounts: BigInt(active.length), recent: BigInt(active.filter((u) => u.lastLoginAt !== null && u.lastLoginAt >= since).length), last };
          }),
        },
      ],
    });
  },
};

const audit: PlatformReport = {
  id: "admin-audit",
  title: "Audit log",
  description: "The identity and administration audit log: who did what to whom, and when.",
  category: "platform",
  roles: SUPER,
  sensitive: true,
  filters: [...PERIOD_FILTERS, { key: "action", label: "Action", type: "search" }, { key: "tenantId", label: "Business", type: "entity", entity: "tenant" }],
  async run(_context, query) {
    const period = periodFilter(query);
    const action = textFilter(query, "action", 60);
    const tenantId = textFilter(query, "tenantId");
    const { start, endExclusive } = businessWindow(period);
    const where: Prisma.AuditLogWhereInput = { occurredAt: { gte: start, lt: endExclusive }, ...(tenantId ? { tenantId } : {}) };
    const rows = (await platformDb.auditLog.findMany({ where, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: 50_001 })).filter((r) => matches(action, r.action));
    const ids = [...new Set(rows.flatMap((r) => [r.actorUserId, r.targetUserId]).filter((id): id is string => id !== null))];
    const people = new Map((await platformDb.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const businessesById = new Map((await platformDb.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId).filter((id): id is string => id !== null))] } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    return doc({
      reportId: "admin-audit",
      title: "Audit log",
      brand: ANGAZA_BRAND,
      period: periodOf(period),
      filters: applied(["Action contains", action], ["Business", tenantId ? businessesById.get(tenantId) ?? tenantId : undefined]),
      sections: [
        {
          name: "Audit log",
          columns: [
            { key: "at", header: "When", kind: "datetime" },
            { key: "action", header: "Action", kind: "text", width: 26 },
            { key: "actor", header: "By", kind: "text", width: 20 },
            { key: "target", header: "To", kind: "text", width: 20 },
            { key: "business", header: "Business", kind: "text", width: 20 },
          ],
          rows: bounded(rows, "audit entries").map((r) => ({
            at: r.occurredAt,
            action: words(r.action),
            actor: r.actorUserId === null ? "Anonymous" : (people.get(r.actorUserId) ?? "A removed user"),
            target: r.targetUserId === null ? null : (people.get(r.targetUserId) ?? "A removed user"),
            business: r.tenantId === null ? null : (businessesById.get(r.tenantId) ?? "A removed business"),
          })),
        },
      ],
    });
  },
};

const donorCohort: PlatformReport = {
  id: "donor-cohort",
  title: "Donor programme figures",
  description: "A programme's combined revenue and profit from its CONSENTING businesses only — each read logged for its owner.",
  category: "donor",
  roles: STAFF,
  sensitive: false,
  filters: [{ key: "projectId", label: "Programme", type: "entity", entity: "donorProject", required: true }, ...PERIOD_FILTERS],
  async run(context, query) {
    const projectId = textFilter(query, "projectId");
    if (projectId === undefined) throw new ReportFilterError("Choose a programme.");
    const period = periodFilter(query);
    const project = await platformDb.donorProject.findUnique({ where: { id: projectId }, select: { name: true, donor: true } });
    if (project === null) throw new ReportFilterError("Choose a programme.");
    const a = await buildCohortAggregate({ userId: context.userId, role: context.role, tenantId: null, ipAddress: null }, projectId, period);
    return doc({
      reportId: "donor-cohort",
      title: "Donor programme figures",
      brand: ANGAZA_BRAND,
      period: periodOf(period),
      filters: applied(["Programme", `${project.name} (${project.donor})`], ["Included", `${a.businessesIncluded.toString()} consenting businesses of ${a.members.total.toString()}`]),
      sections: [
        {
          name: "Summary",
          columns: [{ key: "item", header: "Figure", kind: "text", width: 34 }, { key: "value", header: "Value", kind: "text", width: 20 }, { key: "amount", header: "KES", kind: "money" }],
          rows: [
            { item: "Businesses included (consented)", value: a.businessesIncluded.toString(), amount: null },
            { item: "Members pending consent", value: a.members.pending.toString(), amount: null },
            { item: "Members withdrawn", value: a.members.withdrawn.toString(), amount: null },
            { item: "Total revenue", value: "", amount: a.totalRevenue },
            { item: "Median revenue", value: "", amount: a.medianRevenue },
            { item: "Total net profit", value: "", amount: a.totalNetProfit },
            { item: "Revenue growth vs the period before", value: a.revenueGrowthPct === null ? "Not available" : `${a.revenueGrowthPct}%`, amount: null },
          ],
        },
        {
          name: "Consenting businesses",
          note: "Only businesses whose owner consented are read and listed; every read is in the owner's access log.",
          columns: [
            { key: "name", header: "Business", kind: "text" },
            { key: "revenue", header: "Revenue (KES)", kind: "money", total: true },
            { key: "comparative", header: "Period before (KES)", kind: "money", total: true },
            { key: "net", header: "Net profit (KES)", kind: "money", total: true },
          ],
          rows: a.consentedMembers.map((m) => ({ name: m.businessName, revenue: m.revenue, comparative: m.comparativeRevenue, net: m.netProfit })),
        },
      ],
    });
  },
};

const donorMemberships: PlatformReport = {
  id: "donor-memberships",
  title: "Programme memberships",
  description: "Each programme's member businesses and where their consent stands.",
  category: "donor",
  roles: STAFF,
  sensitive: false,
  filters: [{ key: "projectId", label: "Programme", type: "entity", entity: "donorProject" }, { key: "consent", label: "Consent", type: "select", options: [{ value: "PENDING", label: "Pending" }, { value: "CONSENTED", label: "Consented" }, { value: "WITHDRAWN", label: "Withdrawn" }] }],
  async run(_context, query) {
    const projectId = textFilter(query, "projectId");
    const consent = enumFilter(query, "consent", "Consent", ["PENDING", "CONSENTED", "WITHDRAWN"] as const);
    const members = await platformDb.donorProjectMembership.findMany({
      where: { ...(projectId ? { projectId } : {}), ...(consent ? { consentStatus: consent } : {}) },
      include: { project: { select: { name: true, donor: true, status: true } }, tenant: { select: { name: true, county: true } } },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      take: 50_001,
    });
    return doc({
      reportId: "donor-memberships",
      title: "Programme memberships",
      brand: ANGAZA_BRAND,
      period: null,
      filters: applied(["Programme", projectId ? members[0]?.project.name ?? projectId : undefined], ["Consent", consent?.toLowerCase()]),
      sections: [
        {
          name: "Members",
          columns: [
            { key: "project", header: "Programme", kind: "text", width: 24 },
            { key: "donor", header: "Donor", kind: "text", width: 18 },
            { key: "business", header: "Business", kind: "text" },
            { key: "county", header: "County", kind: "text", width: 14 },
            { key: "consent", header: "Consent", kind: "text", width: 11 },
            { key: "consentAt", header: "Consent changed", kind: "datetime" },
          ],
          rows: bounded(members, "members").map((m) => ({ project: m.project.name, donor: m.project.donor, business: m.tenant.name, county: m.tenant.county, consent: m.consentStatus.toLowerCase(), consentAt: m.consentAt })),
        },
      ],
    });
  },
};

const engagements: PlatformReport = {
  id: "mentorship-engagements",
  title: "Mentorship engagements",
  description: "Every mentoring engagement with its status, and the goals and action items it holds.",
  category: "donor",
  roles: STAFF,
  sensitive: false,
  filters: [{ key: "status", label: "Status", type: "select", options: [{ value: "INVITED", label: "Invited" }, { value: "ACTIVE", label: "Active" }, { value: "ENDED", label: "Ended" }] }],
  async run(_context, query) {
    const status = enumFilter(query, "status", "Status", ["INVITED", "ACTIVE", "ENDED"] as const);
    const list = await platformDb.mentorshipEngagement.findMany({
      where: status ? { status } : {},
      include: { mentor: { select: { fullName: true, role: true } }, tenant: { select: { name: true } }, goals: { select: { status: true } }, actionItems: { select: { status: true } }, _count: { select: { sessions: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50_001,
    });
    return doc({
      reportId: "mentorship-engagements",
      title: "Mentorship engagements",
      brand: ANGAZA_BRAND,
      period: null,
      filters: applied(["Status", status?.toLowerCase()]),
      sections: [
        {
          name: "Engagements",
          note: "Counts only: goals, action items and sessions are platform records; no business figures are read.",
          columns: [
            { key: "mentor", header: "Mentor", kind: "text", width: 22 },
            { key: "business", header: "Business", kind: "text" },
            { key: "status", header: "Status", kind: "text", width: 9 },
            { key: "goals", header: "Goals", kind: "integer", total: true },
            { key: "goalsMet", header: "Goals met", kind: "integer", total: true },
            { key: "actions", header: "Action items", kind: "integer", total: true },
            { key: "actionsDone", header: "Done", kind: "integer", total: true },
            { key: "sessions", header: "Sessions", kind: "integer", total: true },
          ],
          rows: bounded(list, "engagements").map((e) => ({
            mentor: e.mentor.fullName,
            business: e.tenant.name,
            status: e.status.toLowerCase(),
            goals: BigInt(e.goals.length),
            goalsMet: BigInt(e.goals.filter((g) => g.status === "MET").length),
            actions: BigInt(e.actionItems.length),
            actionsDone: BigInt(e.actionItems.filter((a) => a.status === "DONE").length),
            sessions: BigInt(e._count.sessions),
          })),
        },
      ],
    });
  },
};

const integrationHealth: PlatformReport = {
  id: "integration-health",
  title: "M-Pesa and eTIMS adoption and health",
  description: "Which businesses have connected M-Pesa and KRA eTIMS, and whether the last check passed.",
  category: "integrations",
  roles: STAFF,
  sensitive: false,
  filters: [{ key: "provider", label: "Integration", type: "select", options: [{ value: "MPESA", label: "M-Pesa" }, { value: "ETIMS", label: "KRA eTIMS" }] }, { key: "status", label: "Health", type: "select", options: ["HEALTHY", "FAILING", "UNVERIFIED"].map((s) => ({ value: s, label: s.toLowerCase() })) }],
  async run(_context, query) {
    const provider = enumFilter(query, "provider", "Integration", ["MPESA", "ETIMS"] as const);
    const status = enumFilter(query, "status", "Health", ["HEALTHY", "FAILING", "UNVERIFIED"] as const);
    const [health, tenants] = await Promise.all([
      platformDb.integrationHealth.findMany({ where: { ...(provider ? { provider } : {}), ...(status ? { status } : {}) }, orderBy: [{ status: "asc" }, { tenantId: "asc" }], take: 50_001 }),
      platformDb.tenant.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true } }),
    ]);
    const nameOf = new Map(tenants.map((t) => [t.id, t.name]));
    const adoption = (p: string) => new Set(health.filter((h) => h.provider === p).map((h) => h.tenantId)).size;
    return doc({
      reportId: "integration-health",
      title: "M-Pesa and eTIMS adoption and health",
      brand: ANGAZA_BRAND,
      period: null,
      filters: applied(["Integration", provider === "MPESA" ? "M-Pesa" : provider === "ETIMS" ? "KRA eTIMS" : undefined], ["Health", status?.toLowerCase()]),
      sections: [
        {
          name: "Health",
          note: "From the health mirror each business's own check writes; no business's books are read.",
          columns: [
            { key: "business", header: "Business", kind: "text" },
            { key: "provider", header: "Integration", kind: "text", width: 12 },
            { key: "environment", header: "Environment", kind: "text", width: 12 },
            { key: "status", header: "Health", kind: "text", width: 11 },
            { key: "checked", header: "Last check", kind: "datetime" },
            { key: "verified", header: "Last passed", kind: "datetime" },
            { key: "error", header: "Last error", kind: "text", width: 30 },
          ],
          rows: bounded(health, "integration records").map((h) => ({ business: nameOf.get(h.tenantId) ?? "Inactive business", provider: h.provider === "MPESA" ? "M-Pesa" : "KRA eTIMS", environment: h.environment.toLowerCase(), status: h.status.toLowerCase(), checked: h.lastCheckAt, verified: h.lastVerifiedAt, error: h.lastError })),
        },
        {
          name: "Adoption",
          columns: [{ key: "item", header: "Integration", kind: "text" }, { key: "count", header: "Businesses", kind: "integer" }],
          rows: [{ item: "M-Pesa checked at least once", count: BigInt(adoption("MPESA")) }, { item: "KRA eTIMS checked at least once", count: BigInt(adoption("ETIMS")) }, { item: "Active businesses", count: BigInt(tenants.length) }],
        },
      ],
    });
  },
};

const notifications: PlatformReport = {
  id: "notification-delivery",
  title: "Notification delivery",
  description: "Every email and SMS the platform sent in the period, and how each delivery went. Message bodies are never stored.",
  category: "integrations",
  roles: STAFF,
  sensitive: true,
  filters: [
    ...PERIOD_FILTERS,
    { key: "status", label: "Outcome", type: "select", options: ["QUEUED", "SENT", "SIMULATED", "FAILED"].map((s) => ({ value: s, label: s.toLowerCase() })) },
    { key: "channel", label: "Channel", type: "select", options: [{ value: "EMAIL", label: "Email" }, { value: "SMS", label: "SMS" }] },
    { key: "template", label: "Message type", type: "search" },
  ],
  async run(_context, query) {
    const period = periodFilter(query);
    const status = enumFilter(query, "status", "Outcome", ["QUEUED", "SENT", "SIMULATED", "FAILED"] as const);
    const channel = enumFilter(query, "channel", "Channel", ["EMAIL", "SMS"] as const);
    const template = textFilter(query, "template", 60);
    const { start, endExclusive } = businessWindow(period);
    const logs = await platformDb.notificationLog.findMany({
      where: { createdAt: { gte: start, lt: endExclusive }, ...(status ? { status } : {}), ...(channel ? { channel } : {}), ...(template ? { templateKey: { contains: template } } : {}) },
      select: { createdAt: true, channel: true, recipient: true, templateKey: true, status: true, providerName: true, error: true, sentAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50_001,
    });
    /** A recipient shortened: the report is about delivery, not about who. */
    const mask = (to: string) => (to.includes("@") ? to.replace(/^(.).*(@.*)$/, "$1•••$2") : to.replace(/^(\+?\d{3})\d+(\d{3})$/, "$1•••$2"));
    return doc({
      reportId: "notification-delivery",
      title: "Notification delivery",
      brand: ANGAZA_BRAND,
      period: periodOf(period),
      filters: applied(["Outcome", status?.toLowerCase()], ["Channel", channel?.toLowerCase()], ["Message type contains", template]),
      sections: [
        {
          name: "Deliveries",
          columns: [
            { key: "at", header: "When", kind: "datetime" },
            { key: "channel", header: "Channel", kind: "text", width: 8 },
            { key: "to", header: "To", kind: "text", width: 22 },
            { key: "template", header: "Message type", kind: "text", width: 22 },
            { key: "provider", header: "Provider", kind: "text", width: 14 },
            { key: "status", header: "Outcome", kind: "text", width: 10 },
            { key: "error", header: "Reason (if failed)", kind: "text", width: 30 },
          ],
          rows: bounded(logs, "deliveries").map((l) => ({ at: l.createdAt, channel: l.channel.toLowerCase(), to: mask(l.recipient), template: l.templateKey, provider: l.providerName, status: l.status.toLowerCase(), error: l.error })),
        },
        { name: "By outcome", columns: [{ key: "key", header: "Outcome", kind: "text" }, { key: "count", header: "Deliveries", kind: "integer", total: true }], rows: grouped(logs, (l) => l.status.toLowerCase()) },
      ],
    });
  },
};

const jobRuns: PlatformReport = {
  id: "job-runs",
  title: "Scheduled job outcomes",
  description: "Every run of the maintenance jobs in the period — what each did, and any that failed or were skipped.",
  category: "integrations",
  roles: STAFF,
  sensitive: false,
  filters: [
    ...PERIOD_FILTERS,
    { key: "status", label: "Outcome", type: "select", options: ["SUCCEEDED", "FAILED", "SKIPPED", "RUNNING"].map((s) => ({ value: s, label: s.toLowerCase() })) },
    { key: "q", label: "Job", type: "search" },
  ],
  async run(_context, query) {
    const period = periodFilter(query);
    const status = enumFilter(query, "status", "Outcome", ["SUCCEEDED", "FAILED", "SKIPPED", "RUNNING"] as const);
    const q = textFilter(query, "q", 60);
    const { start, endExclusive } = businessWindow(period);
    const runs = await platformDb.jobRun.findMany({
      where: { startedAt: { gte: start, lt: endExclusive }, ...(status ? { status } : {}), ...(q ? { jobName: { contains: q } } : {}) },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      take: 50_001,
    });
    const summaryText = (summary: unknown) =>
      summary !== null && typeof summary === "object" && !Array.isArray(summary)
        ? Object.entries(summary as Record<string, unknown>).map(([k, v]) => `${k} ${String(v)}`).join(", ")
        : null;
    return doc({
      reportId: "job-runs",
      title: "Scheduled job outcomes",
      brand: ANGAZA_BRAND,
      period: periodOf(period),
      filters: applied(["Outcome", status?.toLowerCase()], ["Job contains", q]),
      sections: [
        {
          name: "Runs",
          columns: [
            { key: "at", header: "Started", kind: "datetime" },
            { key: "job", header: "Job", kind: "text", width: 24 },
            { key: "trigger", header: "Trigger", kind: "text", width: 10 },
            { key: "status", header: "Outcome", kind: "text", width: 10 },
            { key: "attempts", header: "Attempts", kind: "integer", width: 8 },
            { key: "finished", header: "Finished", kind: "datetime" },
            { key: "summary", header: "What it did", kind: "text", width: 36 },
            { key: "error", header: "Reason", kind: "text", width: 36 },
          ],
          rows: bounded(runs, "runs").map((r) => ({ at: r.startedAt, job: r.jobName, trigger: r.trigger.toLowerCase(), status: r.status.toLowerCase(), attempts: BigInt(r.attempts), finished: r.finishedAt, summary: summaryText(r.summary), error: r.error })),
        },
        { name: "By outcome", columns: [{ key: "key", header: "Outcome", kind: "text" }, { key: "count", header: "Runs", kind: "integer", total: true }], rows: grouped(runs, (r) => r.status.toLowerCase()) },
      ],
    });
  },
};

export const PLATFORM_REPORTS: PlatformReport[] = [businesses, breakdown, applications, trends, users, adoption, audit, donorCohort, donorMemberships, engagements, integrationHealth, notifications, jobRuns];
