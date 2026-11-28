import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, sendJson, withParams } from "@/lib/api/request";
import type { Role } from "@/lib/auth/landing";

// People & access: the business's own staff, invitations, role changes, deactivation and the
// identity audit log (/v1/users). The RULES are the server's — who may grant which role, never
// losing the last active owner — and its refusals are shown as they are. The tenant is the
// session's: no call here names one.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;

export type StaffList = Json<paths["/v1/users/"]["get"]["responses"][200]>;
export type Staff = StaffList["data"][number];
export type InviteResult = Json<paths["/v1/users/invite"]["post"]["responses"][201]>;
export type Invitation = InviteResult["invitation"];
export type Delivery = InviteResult["delivery"]["email"];
export type AuditList = Json<paths["/v1/users/audit"]["get"]["responses"][200]>;
export type AuditEntry = AuditList["data"][number];

/**
 * The roles an owner may give inside their own business: every TENANT role, up to and including
 * their own (a co-owner is equal, not above). The platform roles (SUPER_ADMIN, PROGRAM_OFFICER,
 * MENTOR, COACH) are tenantless and a SUPER_ADMIN's to grant — the API refuses them from an owner.
 */
export const TENANT_ROLES = ["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "CASHIER", "HR_OFFICER", "WAREHOUSE_STAFF", "VIEWER_AUDITOR"] as const satisfies readonly Role[];
export type TenantRole = (typeof TENANT_ROLES)[number];

export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  MSME_OWNER: "Owner",
  MSME_MANAGER: "Manager",
  ACCOUNTANT: "Accountant",
  CASHIER: "Cashier",
  HR_OFFICER: "HR officer",
  WAREHOUSE_STAFF: "Warehouse staff",
  VIEWER_AUDITOR: "Viewer / auditor",
  SUPER_ADMIN: "Platform administrator",
  PROGRAM_OFFICER: "Programme officer",
  MENTOR: "Mentor",
  COACH: "Coach",
};

export const ROLE_MEANING: Readonly<Record<TenantRole, string>> = {
  MSME_OWNER: "Everything, including settings, integrations and people.",
  MSME_MANAGER: "Runs the shop: selling, stock, purchasing, customers and expenses.",
  ACCOUNTANT: "The books, reports, payables, receivables and tax.",
  CASHIER: "The till only.",
  HR_OFFICER: "Employees and payroll preparation.",
  WAREHOUSE_STAFF: "Receiving, counting and moving stock.",
  VIEWER_AUDITOR: "Reads the books and reports; changes nothing.",
};

export const DELIVERY_LABEL: Readonly<Record<Delivery, string>> = {
  SENT: "sent",
  SIMULATED: "simulated — this environment does not send real messages",
  QUEUED: "queued",
  FAILED: "failed to send",
};

export const AUDIT_LABEL: Readonly<Record<string, string>> = {
  USER_INVITED: "Invited a user",
  INVITATION_ACCEPTED: "Accepted an invitation",
  INVITATION_REVOKED: "Revoked an invitation",
  ROLE_CHANGED: "Changed a role",
  USER_DEACTIVATED: "Deactivated a user",
  USER_REACTIVATED: "Reactivated a user",
  PASSWORD_RESET_REQUESTED: "Asked to reset a password",
  PASSWORD_RESET_COMPLETED: "Reset a password",
  PASSWORD_CHANGED: "Changed a password",
  TENANT_ONBOARDED: "Business onboarded",
  TENANT_SUSPENDED: "Business suspended",
  TENANT_REACTIVATED: "Business reactivated",
  TENANT_DEACTIVATED: "Business deactivated",
  DONOR_CONSENT_GIVEN: "Consented to a donor project",
  DONOR_CONSENT_WITHDRAWN: "Withdrew from a donor project",
  OPERATOR_ACTED: "Platform operator acted",
};

// ---- Calls ----

export const fetchStaff = () => getJson<StaffList>("/users");
/** The business's OPEN invitations (PENDING, unexpired), newest first — T-B-INVITE-LIST. */
export const fetchPendingInvitations = () => getJson<{ data: Invitation[] }>("/users/invitations");
export const fetchAudit = (limit: number) => getJson<AuditList>(withParams("/users/audit", { limit: limit.toString() }));
export const inviteUser = (body: { email: string; role: TenantRole; phone?: string }) => sendJson<InviteResult>("POST", "/users/invite", body);
export const revokeInvitation = (id: string) => sendJson<Invitation>("POST", `/users/invitations/${encodeURIComponent(id)}/revoke`);
export const changeRole = (id: string, role: TenantRole) => sendJson<Staff>("PATCH", `/users/${encodeURIComponent(id)}/role`, { role });
export const deactivateUser = (id: string) => sendJson<Staff>("POST", `/users/${encodeURIComponent(id)}/deactivate`);
export const reactivateUser = (id: string) => sendJson<Staff>("POST", `/users/${encodeURIComponent(id)}/reactivate`);

// ---- Queries ----

export const peopleKeys = {
  all: ["people"] as const,
  staff: () => ["people", "staff"] as const,
  invitations: () => ["people", "invitations"] as const,
  audit: (limit: number) => ["people", "audit", limit] as const,
};

export const useStaff = () => useQuery({ queryKey: peopleKeys.staff(), queryFn: fetchStaff, staleTime: 0 });
export const usePendingInvitations = () => useQuery({ queryKey: peopleKeys.invitations(), queryFn: fetchPendingInvitations, staleTime: 0 });
export const useAudit = (limit: number) => useQuery({ queryKey: peopleKeys.audit(limit), queryFn: () => fetchAudit(limit), staleTime: 0 });

/** After any change to people: the staff list and the audit trail are both stale. */
export function useInvalidatePeople(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await client.invalidateQueries({ queryKey: peopleKeys.all });
  }, [client]);
}

export const isTenantRole = (role: Role): role is TenantRole => (TENANT_ROLES as readonly Role[]).includes(role);

/** A simple email shape check before sending — the server is the authority. */
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
