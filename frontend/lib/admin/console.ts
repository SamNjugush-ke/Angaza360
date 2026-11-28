import { useQuery } from "@tanstack/react-query";
import type { paths } from "@/lib/api/schema";
import { getJson, sendJson, withParams } from "@/lib/api/request";

// THE COMMAND CENTER (M4.5 Wave 5): the platform console's own reads and actions, beside the
// onboarding / tenant / donor / user calls in ./admin. Everything here is PLATFORM data, except a
// operator (god-mode) activity on a business (/support-access/my-business, attributed to "Platform operator").
// A business.s
// M-Pesa / eTIMS credentials are never read here: the console shows only their HEALTH (the mirror).
// Money arrives as strings of cents; dates are formatted in Africa/Nairobi by the caller.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;

export type Overview = Json<paths["/v1/platform-reports/overview"]["get"]["responses"][200]>;
export type ActivityEntry = Overview["recentActivity"][number];
export type HealthList = Json<paths["/v1/tenants/integration-health"]["get"]["responses"][200]>;
export type HealthRow = HealthList["data"][number];
export type JobList = Json<paths["/v1/jobs/"]["get"]["responses"][200]>;
export type Job = JobList["data"][number];
export type JobRun = Json<paths["/v1/jobs/runs"]["get"]["responses"][200]>["data"][number];
export type PlatformCredentials = Json<paths["/v1/platform-credentials/"]["get"]["responses"][200]>;
export type CredentialSlot = PlatformCredentials["data"][number];
export type SafeCredential = NonNullable<CredentialSlot["credential"]>;
export type CredentialField = PlatformCredentials["fields"][string][number];
export type VerifyResult = Json<paths["/v1/platform-credentials/{provider}/{environment}/verify"]["post"]["responses"][200]>;
export type OperatorActivity = Json<paths["/v1/support-access/my-business"]["get"]["responses"][200]>;
export type DirectoryPage = Json<paths["/v1/users/directory"]["get"]["responses"][200]>;
export type DirectoryUser = DirectoryPage["data"][number];

export type PlatformProvider = "SMTP" | "SENDGRID" | "AFRICASTALKING";
export type PlatformEnvironment = "sandbox" | "production";

const id = (value: string) => encodeURIComponent(value);

// ---- Reads ----

export const fetchOverview = () => getJson<Overview>("/platform-reports/overview");
export const fetchHealth = (filters: { tenantId?: string; status?: "HEALTHY" | "FAILING" | "" }) =>
  getJson<HealthList>(withParams("/tenants/integration-health", { tenantId: filters.tenantId, status: filters.status || undefined }));
export const fetchJobs = () => getJson<JobList>("/jobs");
export const fetchJobRuns = (filters: { jobName?: string; status?: string; take?: number }) =>
  getJson<{ data: JobRun[] }>(withParams("/jobs/runs", { jobName: filters.jobName, status: filters.status || undefined, take: (filters.take ?? 25).toString() }));
export const fetchPlatformCredentials = () => getJson<PlatformCredentials>("/platform-credentials");
// The owner's transparency surface: operator (god-mode) actions on their own business.
export const fetchOperatorActivity = () => getJson<OperatorActivity>("/support-access/my-business");
export const fetchBusinessUsers = (tenantId: string) => getJson<DirectoryPage>(withParams("/users/directory", { tenantId, take: "100" }));

// ---- Actions ----

/** A fresh MFA step-up for this session: required before a SUPER_ADMIN's sensitive console actions. */
export const stepUp = (code: string) => sendJson<{ stepUpAt: string }>("POST", "/auth/mfa/step-up", { code });

/** A console job run: the same idempotency key is the same run, so a double click runs once. */
export const runJob = (name: string, idempotencyKey: string) =>
  sendJson<JobRun>("POST", `/jobs/${id(name)}/run`, undefined, { "idempotency-key": idempotencyKey });

export const storePlatformCredential = (provider: PlatformProvider, environment: PlatformEnvironment, fields: Readonly<Record<string, string>>, label?: string) =>
  sendJson<SafeCredential>("PUT", `/platform-credentials/${provider}/${environment}`, { fields, ...(label ? { label } : {}) });
export const setPlatformCredentialActive = (provider: PlatformProvider, environment: PlatformEnvironment, active: boolean) =>
  sendJson<SafeCredential>("POST", `/platform-credentials/${provider}/${environment}/${active ? "activate" : "deactivate"}`);
export const verifyPlatformCredential = (provider: PlatformProvider, environment: PlatformEnvironment) =>
  sendJson<VerifyResult>("POST", `/platform-credentials/${provider}/${environment}/verify`);

// START / STOP acting as a business (god-mode). These set the HttpOnly act-as cookie through the
// BFF — the token never reaches JavaScript, and the data proxy forwards it as x-act-as-tenant.
export async function startActingAs(tenantId: string, name: string): Promise<void> {
  const response = await fetch("/api/act-as", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId, name }) });
  if (!response.ok) throw new Error("Could not start acting as that business.");
}
export async function stopActingAs(): Promise<void> {
  await fetch("/api/act-as", { method: "DELETE" });
}

/** A new key per user action — the console never reuses one across clicks. */
export function newIdempotencyKey(): string {
  return `console-${globalThis.crypto.randomUUID()}`;
}

// ---- Hooks ----

export const consoleKeys = {
  all: ["console"] as const,
  overview: () => ["console", "overview"] as const,
  health: (filters: string) => ["console", "health", filters] as const,
  jobs: () => ["console", "jobs"] as const,
  runs: (filters: string) => ["console", "runs", filters] as const,
  credentials: () => ["console", "credentials"] as const,
  operatorActivity: () => ["console", "operator-activity"] as const,
  users: (tenantId: string) => ["console", "users", tenantId] as const,
};

export const useOverview = () => useQuery({ queryKey: consoleKeys.overview(), queryFn: fetchOverview, staleTime: 0 });
export const useHealth = (filters: { tenantId?: string; status?: "HEALTHY" | "FAILING" | "" }) =>
  useQuery({ queryKey: consoleKeys.health(JSON.stringify(filters)), queryFn: () => fetchHealth(filters), staleTime: 0 });
export const useJobs = () => useQuery({ queryKey: consoleKeys.jobs(), queryFn: fetchJobs, staleTime: 0 });
export const useJobRuns = (filters: { jobName?: string; status?: string; take?: number }) =>
  useQuery({ queryKey: consoleKeys.runs(JSON.stringify(filters)), queryFn: () => fetchJobRuns(filters), staleTime: 0 });
export const usePlatformCredentials = (enabled = true) => useQuery({ queryKey: consoleKeys.credentials(), queryFn: fetchPlatformCredentials, staleTime: 0, enabled });
export const useOperatorActivity = () => useQuery({ queryKey: consoleKeys.operatorActivity(), queryFn: fetchOperatorActivity, staleTime: 0 });
export const useBusinessUsers = (tenantId: string) => useQuery({ queryKey: consoleKeys.users(tenantId), queryFn: () => fetchBusinessUsers(tenantId), staleTime: 0 });

// ---- Words ----

export const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  MPESA: "M-Pesa",
  ETIMS: "KRA eTIMS",
  SMTP: "SMTP email",
  SENDGRID: "SendGrid email",
  AFRICASTALKING: "Africa’s Talking SMS",
};

export const JOB_LABEL: Readonly<Record<string, string>> = {
  "etims-retry": "Retry queued eTIMS invoices",
  "expire-leases": "Freeze expired till leases",
  "expire-mpesa": "Time out unanswered M-Pesa prompts",
  "mpesa-reconcile": "Reconcile M-Pesa with Safaricom",
  "expire-tokens": "Expire invitations and codes",
  "export-cleanup": "Clean up expired exports",
  "notification-sweep": "Close stuck notifications",
  "application-documents-purge": "Purge retained ID documents",
};

/** "audit action" -> words, for the activity feed. Unknown actions read as their own name. */
export const ACTION_WORDS: Readonly<Record<string, string>> = {
  PASSWORD_RESET_REQUESTED: "asked for a password reset",
  PASSWORD_RESET_COMPLETED: "reset a password",
  PASSWORD_CHANGED: "changed a password",
  USER_INVITED: "invited a user",
  INVITATION_ACCEPTED: "accepted an invitation",
  INVITATION_REVOKED: "revoked an invitation",
  ROLE_CHANGED: "changed a role",
  USER_DEACTIVATED: "deactivated a user",
  USER_REACTIVATED: "reactivated a user",
  TENANT_ONBOARDED: "set up a business",
  TENANT_SUSPENDED: "suspended a business",
  TENANT_REACTIVATED: "reactivated a business",
  TENANT_DEACTIVATED: "deactivated a business",
  APPLICATION_SUBMITTED: "submitted an application",
  APPLICATION_APPROVED: "approved an application",
  APPLICATION_REJECTED: "rejected an application",
  APPLICATION_CORRECTED: "corrected an application",
  APPLICATION_DOCUMENT_VIEWED: "viewed an ID document",
  BATCH_UPLOADED: "uploaded an onboarding batch",
  BATCH_COMMITTED: "committed an onboarding batch",
  SUPPORT_ACCESS_GRANTED: "granted support access",
  SUPPORT_ACCESS_REVOKED: "revoked support access",
  SUPPORT_ACCESS_USED: "used support access",
  REPORT_EXPORTED: "exported a report",
  REPORT_EXPORT_DOWNLOADED: "downloaded an export",
  PLATFORM_CREDENTIAL_STORED: "stored a platform credential",
  PLATFORM_CREDENTIAL_ACTIVATED: "activated a platform credential",
  PLATFORM_CREDENTIAL_DEACTIVATED: "deactivated a platform credential",
  PLATFORM_CREDENTIAL_VERIFIED: "verified a platform credential",
  MFA_RESET: "reset a user’s two-step verification",
  PASSWORD_ADMIN_RESET: "issued a temporary password",
  SESSION_REVOKED: "signed a session out",
  DONOR_CONSENT_GIVEN: "consented to a programme",
  DONOR_CONSENT_WITHDRAWN: "withdrew from a programme",
};

export const actionWords = (action: string) => ACTION_WORDS[action] ?? action.toLowerCase().replaceAll("_", " ");
