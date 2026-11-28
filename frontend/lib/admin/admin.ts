import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, getText, sendCsv, sendDelete, sendJson, withParams } from "@/lib/api/request";
import type { Role } from "@/lib/auth/landing";

// Platform administration (SUPER_ADMIN, PROGRAM_OFFICER): the onboarding queue and batch CSV
// onboarding (/v1/tenant-applications), the tenant registry and lifecycle (/v1/tenants), donor
// projects (/v1/donor-projects, staff side), inviting a mentor to a business (/v1/mentorship), staff
// and platform users (/v1/users) and the identity audit log. Provisioning and every grant of a role
// in a business are the SUPER_ADMIN's alone; a programme officer prepares, reviews and rejects. The
// green-gate and every rule are the server's.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<T> = T extends { requestBody: { content: { "application/json": infer B } } } ? B : never;

export type ApplicationList = Json<paths["/v1/tenant-applications/"]["get"]["responses"][200]>;
export type Application = ApplicationList["data"][number];
export type ApplicationStatus = Application["status"];
export type ApplicationSource = Application["source"];
export type ApplicationReview = Json<paths["/v1/tenant-applications/{id}"]["get"]["responses"][200]>;
export type Approved = Json<paths["/v1/tenant-applications/{id}/approve"]["post"]["responses"][200]>;
export type BatchPreview = Json<paths["/v1/tenant-applications/batch/{batchId}"]["get"]["responses"][200]>;
export type PreviewRow = BatchPreview["rows"][number];
export type BatchCommit = Json<paths["/v1/tenant-applications/batch/{batchId}/commit"]["post"]["responses"][200]>;
export type Candidate = Body<paths["/v1/tenants/onboard"]["post"]>;
export type CandidateError = PreviewRow["errors"][number];
export type ValidationReport = Json<paths["/v1/tenants/onboard/validate"]["post"]["responses"][200]>;
export type Onboarded = Json<paths["/v1/tenants/onboard"]["post"]["responses"][201]>;
export type TenantList = Json<paths["/v1/tenants/"]["get"]["responses"][200]>;
export type Tenant = TenantList["data"][number];
export type TenantStatus = Tenant["status"];
export type ProjectList = Json<paths["/v1/donor-projects/"]["get"]["responses"][200]>;
export type Project = ProjectList["data"][number];
export type ProjectDetail = Json<paths["/v1/donor-projects/{id}"]["get"]["responses"][200]>;
export type Member = ProjectDetail["members"][number];
export type Aggregate = Json<paths["/v1/donor-projects/{id}/aggregate"]["get"]["responses"][200]>;
export type Engagement = Json<paths["/v1/mentorship/engagements"]["post"]["responses"][201]>;
export type AuditList = Json<paths["/v1/users/audit"]["get"]["responses"][200]>;
export type AuditEntry = AuditList["data"][number];
export type InviteResult = Json<paths["/v1/users/invite"]["post"]["responses"][201]>;
export type Staff = Json<paths["/v1/users/{id}/role"]["patch"]["responses"][200]>;

// ---- Who may do what (the API's guards) ----

export const adminPermissions = (role: Role) => ({
  /** Approve an application, commit a batch, onboard a business, and /v1/users. */
  isSuperAdmin: role === "SUPER_ADMIN",
  /** Everything else here: review, reject, batch upload and correction, tenants and their lifecycle, donor projects, the audit log. */
  isPlatform: role === "SUPER_ADMIN" || role === "PROGRAM_OFFICER",
});
export type AdminPermissions = ReturnType<typeof adminPermissions>;

// ---- Calls ----

const id = (value: string) => encodeURIComponent(value);
export const fetchApplications = (filters: { status?: ApplicationStatus | ""; source?: ApplicationSource | "" }) =>
  getJson<ApplicationList>(withParams("/tenant-applications", { status: filters.status || undefined, source: filters.source || undefined }));
export const fetchApplication = (applicationId: string) => getJson<ApplicationReview>(`/tenant-applications/${id(applicationId)}`);
export const approveApplication = (applicationId: string) => sendJson<Approved>("POST", `/tenant-applications/${id(applicationId)}/approve`);
export const rejectApplication = (applicationId: string, reason: string) => sendJson<Application>("POST", `/tenant-applications/${id(applicationId)}/reject`, { reason });
// The review (M4.5 W2).
export type Correction = Body<paths["/v1/tenant-applications/{id}/corrections"]["patch"]>;
export type DocumentMeta = ApplicationReview["documents"][number];
export type TimelineEvent = ApplicationReview["timeline"][number];
export const startReview = (applicationId: string) => sendJson<Application>("POST", `/tenant-applications/${id(applicationId)}/start-review`);
export const requestChanges = (applicationId: string, message: string) => sendJson<Application>("POST", `/tenant-applications/${id(applicationId)}/request-changes`, { message });
export const correctApplication = (applicationId: string, body: Correction) => sendJson<Application>("PATCH", `/tenant-applications/${id(applicationId)}/corrections`, body);
/** A single-use, two-minute grant to view one ID document; open it at documentViewUrl(token). */
export const documentViewGrant = (applicationId: string, documentId: string) =>
  sendJson<{ token: string; expiresAt: string }>("POST", `/tenant-applications/${id(applicationId)}/documents/${id(documentId)}/view-grant`);
export const documentViewUrl = (token: string) => `/api/v1/tenant-applications/documents/view/${encodeURIComponent(token)}`;
export const fetchTemplate = () => getText("/tenant-applications/batch/template");
export const uploadBatch = (csv: string) => sendCsv<BatchPreview>("/tenant-applications/batch", csv);
export const fetchBatch = (batchId: string) => getJson<BatchPreview>(`/tenant-applications/batch/${id(batchId)}`);
export const commitBatch = (batchId: string) => sendJson<BatchCommit>("POST", `/tenant-applications/batch/${id(batchId)}/commit`);
export const editRow = (applicationId: string, body: Partial<Candidate>) => sendJson<PreviewRow>("PATCH", `/tenant-applications/${id(applicationId)}`, body);
export const removeRow = (applicationId: string) => sendDelete(`/tenant-applications/${id(applicationId)}`);

export const fetchTenants = (status: TenantStatus | "") => getJson<TenantList>(withParams("/tenants", { status: status || undefined }));
export const fetchTenant = (tenantId: string) => getJson<Tenant>(`/tenants/${id(tenantId)}`);
export const validateCandidate = (body: Candidate) => sendJson<ValidationReport>("POST", "/tenants/onboard/validate", body);
export const onboard = (body: Candidate) => sendJson<Onboarded>("POST", "/tenants/onboard", body);
export const tenantLifecycle = (tenantId: string, action: "suspend" | "reactivate" | "deactivate", reason?: string) =>
  sendJson<Tenant>("POST", `/tenants/${id(tenantId)}/${action}`, reason ? { reason } : {});

export const fetchProjects = (status: Project["status"] | "") => getJson<ProjectList>(withParams("/donor-projects", { status: status || undefined }));
export const fetchProject = (projectId: string) => getJson<ProjectDetail>(`/donor-projects/${id(projectId)}`);
export const createProject = (body: { code: string; name: string; donor: string; description?: string }) => sendJson<{ project: Project; seeded: number }>("POST", "/donor-projects", body);
export const closeProject = (projectId: string) => sendJson<Project>("POST", `/donor-projects/${id(projectId)}/close`);
export const addMember = (projectId: string, tenantId: string) => sendJson<Member>("POST", `/donor-projects/${id(projectId)}/members`, { tenantId });
export const removeMember = (projectId: string, tenantId: string) => sendDelete(`/donor-projects/${id(projectId)}/members/${id(tenantId)}`);
export const fetchAggregate = (projectId: string, period: Readonly<Record<string, string | undefined>>) => getJson<Aggregate>(withParams(`/donor-projects/${id(projectId)}/aggregate`, period));

export const fetchAllEngagements = () => getJson<{ data: Engagement[]; count: number }>("/mentorship/engagements");
export const inviteMentor = (mentorId: string, tenantId: string) => sendJson<Engagement>("POST", "/mentorship/engagements", { mentorId, tenantId });

export const fetchAudit = (filters: { limit: number; tenantId?: string }) => getJson<AuditList>(withParams("/users/audit", { limit: filters.limit.toString(), tenantId: filters.tenantId || undefined }));
export const inviteUser = (body: { email: string; role: Role; tenantId?: string; phone?: string }) => sendJson<InviteResult>("POST", "/users/invite", body);
export const revokeInvitation = (invitationId: string) => sendJson<InviteResult["invitation"]>("POST", `/users/invitations/${id(invitationId)}/revoke`);
export const changeRole = (userId: string, role: Role) => sendJson<Staff>("PATCH", `/users/${id(userId)}/role`, { role });
export const setUserActive = (userId: string, active: boolean) => sendJson<Staff>("POST", `/users/${id(userId)}/${active ? "reactivate" : "deactivate"}`);

// ---- Queries ----

export const adminKeys = {
  all: ["admin"] as const,
  applications: (filters: string) => ["admin", "applications", filters] as const,
  application: (applicationId: string) => ["admin", "application", applicationId] as const,
  batch: (batchId: string) => ["admin", "batch", batchId] as const,
  tenants: (status: string) => ["admin", "tenants", status] as const,
  projects: (status: string) => ["admin", "projects", status] as const,
  project: (projectId: string) => ["admin", "project", projectId] as const,
  aggregate: (projectId: string, period: string) => ["admin", "aggregate", projectId, period] as const,
  engagements: () => ["admin", "engagements"] as const,
  audit: (filters: string) => ["admin", "audit", filters] as const,
};

export const useApplications = (filters: { status: ApplicationStatus | ""; source: ApplicationSource | "" }) =>
  useQuery({ queryKey: adminKeys.applications(JSON.stringify(filters)), queryFn: () => fetchApplications(filters), staleTime: 0 });
export const useApplication = (applicationId: string) => useQuery({ queryKey: adminKeys.application(applicationId), queryFn: () => fetchApplication(applicationId), staleTime: 0 });
export const useBatch = (batchId: string | null) => useQuery({ queryKey: adminKeys.batch(batchId ?? ""), queryFn: () => fetchBatch(batchId ?? ""), enabled: batchId !== null, staleTime: 0 });
export const useTenants = (status: TenantStatus | "") => useQuery({ queryKey: adminKeys.tenants(status), queryFn: () => fetchTenants(status), staleTime: 0 });
export const useProjects = (status: Project["status"] | "") => useQuery({ queryKey: adminKeys.projects(status), queryFn: () => fetchProjects(status), staleTime: 0 });
export const useProject = (projectId: string) => useQuery({ queryKey: adminKeys.project(projectId), queryFn: () => fetchProject(projectId), staleTime: 0 });
export const useAggregate = (projectId: string, period: Readonly<Record<string, string | undefined>> | null) =>
  useQuery({ queryKey: adminKeys.aggregate(projectId, JSON.stringify(period ?? {})), queryFn: () => fetchAggregate(projectId, period ?? {}), enabled: period !== null, staleTime: 0, retry: false });
export const useAllEngagements = () => useQuery({ queryKey: adminKeys.engagements(), queryFn: fetchAllEngagements, staleTime: 0 });
export const useAudit = (filters: { limit: number; tenantId?: string }) => useQuery({ queryKey: adminKeys.audit(JSON.stringify(filters)), queryFn: () => fetchAudit(filters), staleTime: 0 });

export function useInvalidateAdmin(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await client.invalidateQueries({ queryKey: adminKeys.all });
  }, [client]);
}

// ---- Words ----

export const APPLICATION_STATUS_LABEL: Readonly<Record<ApplicationStatus, string>> = {
  DRAFT: "Draft",
  SUBMITTED: "Waiting for review",
  UNDER_REVIEW: "Under review",
  NEEDS_CHANGES: "Waiting for the applicant",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};
/** The statuses staff filter by — a DRAFT is the applicant's unfinished form and is never listed. */
export const STAFF_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "NEEDS_CHANGES", "APPROVED", "REJECTED"] as const satisfies readonly ApplicationStatus[];
export const STRUCTURE_LABEL: Readonly<Record<string, string>> = { SOLE_PROPRIETOR: "Sole proprietor", PARTNERSHIP: "Partnership", LIMITED_COMPANY: "Limited company" };
export const TIMELINE_LABEL: Readonly<Record<string, string>> = {
  SUBMITTED: "Submitted",
  REVIEW_STARTED: "Review started",
  CHANGES_REQUESTED: "Changes requested",
  CORRECTED: "Details corrected",
  RESUBMITTED: "Resubmitted",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  DOCUMENTS_PURGED: "ID document deleted (retention)",
};
export const SOURCE_LABEL: Readonly<Record<ApplicationSource, string>> = { SELF_SERVE: "Self sign-up", ADMIN: "Admin", BATCH: "Batch upload" };
export const TENANT_STATUS_LABEL: Readonly<Record<TenantStatus, string>> = { PENDING_PROVISIONING: "Being set up", ACTIVE: "Active", SUSPENDED: "Suspended", DEACTIVATED: "Deactivated" };
export const REGIMES = ["VAT_REGISTERED", "TURNOVER_TAX", "EXEMPT"] as const;
export const REGIME_LABEL: Readonly<Record<string, string>> = { VAT_REGISTERED: "VAT registered", VAT: "VAT registered", TURNOVER_TAX: "Turnover Tax", EXEMPT: "Exempt" };
export const CANDIDATE_FIELD_LABEL: Readonly<Record<string, string>> = {
  businessName: "Business name",
  subdomain: "Subdomain",
  sector: "Sector",
  kraPin: "KRA PIN",
  taxRegime: "Tax regime",
  requestedTier: "Plan",
  ownerFullName: "Owner’s full name",
  ownerEmail: "Owner’s email",
  ownerPhone: "Owner’s phone",
  ownerNationalId: "Owner’s National ID",
  businessStructure: "Business structure",
  registrationNumber: "Registration number",
  businessKraPin: "Business KRA PIN",
  description: "Description",
  physicalAddress: "Physical address",
  county: "County",
  permitNumber: "Business permit number",
  businessPhone: "Business phone",
  businessEmail: "Business email",
};
export const PLATFORM_ROLES = ["SUPER_ADMIN", "PROGRAM_OFFICER", "MENTOR", "COACH"] as const satisfies readonly Role[];
export const TENANT_ROLES = ["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "CASHIER", "HR_OFFICER", "WAREHOUSE_STAFF", "VIEWER_AUDITOR"] as const satisfies readonly Role[];

// ---- The platform user directory (T-B-ADMIN-USER-LIST) ----

export type DirectoryList = Json<paths["/v1/users/directory"]["get"]["responses"][200]>;
export type DirectoryUser = DirectoryList["data"][number];
export const fetchDirectory = (filters: { q?: string; role?: Role | ""; take?: number; skip?: number }) =>
  getJson<DirectoryList>(withParams("/users/directory", { q: filters.q || undefined, role: filters.role || undefined, take: filters.take?.toString(), skip: filters.skip?.toString() }));
export const useDirectory = (filters: { q?: string; role?: Role | ""; take?: number; skip?: number }, enabled = true) =>
  useQuery({ queryKey: ["admin", "directory", JSON.stringify(filters)], queryFn: () => fetchDirectory(filters), enabled, staleTime: 0 });
