import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, sendJson } from "@/lib/api/request";

// Mentorship (/v1/mentorship) and the owner's donor-programme memberships (/v1/donor-projects/my-*).
//
// THE PRIVACY MODEL: a mentor reads a business's figures ONLY through an ACTIVE engagement — one its
// owner has CONSENTED to — and every read is logged before data is returned; the owner reads that
// log and can end the engagement at will. A donor programme reads a member business's books only
// while its owner's consent stands, logged the same way. The server enforces all of it (an
// engagement that is not the caller's, not consented or ended is a plain 404); this layer only
// carries values. Money: shillings on requests, cents strings on responses; rates are decimal strings.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<T> = T extends { requestBody: { content: { "application/json": infer B } } } ? B : never;

export type EngagementList = Json<paths["/v1/mentorship/engagements"]["get"]["responses"][200]>;
export type Engagement = EngagementList["data"][number];
export type EngagementStatus = Engagement["status"];
export type Snapshot = Json<paths["/v1/mentorship/engagements/{id}/snapshot"]["get"]["responses"][200]>;
export type Dashboard = Json<paths["/v1/mentorship/engagements/{id}/dashboard"]["get"]["responses"][200]>;
export type DashboardIndicator = Dashboard["indicators"][number];
export type Goal = Json<paths["/v1/mentorship/goals/{id}"]["patch"]["responses"][200]>;
export type GoalBody = Body<paths["/v1/mentorship/engagements/{id}/goals"]["post"]>;
export type GoalStatus = Goal["status"];
export type Indicator = Json<paths["/v1/mentorship/engagements/{id}/indicators"]["post"]["responses"][201]>;
export type IndicatorBody = Body<paths["/v1/mentorship/engagements/{id}/indicators"]["post"]>;
export type SourceKey = Indicator["sourceKey"];
export type Actual = Json<paths["/v1/mentorship/indicators/{id}/actual"]["get"]["responses"][200]>;
export type ActionItem = Json<paths["/v1/mentorship/action-items/{id}"]["patch"]["responses"][200]>;
export type ActionItemBody = Body<paths["/v1/mentorship/engagements/{id}/action-items"]["post"]>;
export type ActionItemStatus = ActionItem["status"];
export type ActionParty = ActionItem["responsibleParty"];
export type Session = Json<paths["/v1/mentorship/sessions/{id}"]["get"]["responses"][200]>;
export type SessionBody = Body<paths["/v1/mentorship/engagements/{id}/sessions"]["post"]>;
export type Cohort = Json<paths["/v1/mentorship/cohort"]["get"]["responses"][200]>;
export type AccessLog = Json<paths["/v1/mentorship/engagements/{id}/access-log"]["get"]["responses"][200]>;
export type OwnerView = Json<paths["/v1/mentorship/my-engagements/{id}"]["get"]["responses"][200]>;
export type MembershipList = Json<paths["/v1/donor-projects/my-memberships"]["get"]["responses"][200]>;
export type MembershipEntry = MembershipList["data"][number];
export type Membership = MembershipEntry["membership"];
export type MembershipLog = Json<paths["/v1/donor-projects/my-memberships/{id}/access-log"]["get"]["responses"][200]>;

const id = (value: string) => encodeURIComponent(value);

// ---- Calls: the mentor ----

export const fetchEngagements = () => getJson<EngagementList>("/mentorship/engagements");
export const fetchDashboard = (engagementId: string) => getJson<Dashboard>(`/mentorship/engagements/${id(engagementId)}/dashboard`);
export const fetchSnapshot = (engagementId: string) => getJson<Snapshot>(`/mentorship/engagements/${id(engagementId)}/snapshot`);
export const fetchActual = (indicatorId: string) => getJson<Actual>(`/mentorship/indicators/${id(indicatorId)}/actual`);
export const fetchActionItems = (engagementId: string) => getJson<{ data: ActionItem[]; count: number }>(`/mentorship/engagements/${id(engagementId)}/action-items`);
export const fetchSessions = (engagementId: string) => getJson<{ data: Session[]; count: number }>(`/mentorship/engagements/${id(engagementId)}/sessions`);
export const fetchSession = (sessionId: string) => getJson<Session>(`/mentorship/sessions/${id(sessionId)}`);
export const fetchCohort = () => getJson<Cohort>("/mentorship/cohort");
export const fetchAccessLog = (engagementId: string) => getJson<AccessLog>(`/mentorship/engagements/${id(engagementId)}/access-log`);
export const createGoal = (engagementId: string, body: GoalBody) => sendJson<Goal>("POST", `/mentorship/engagements/${id(engagementId)}/goals`, body);
export const updateGoal = (goalId: string, body: { status: GoalStatus }) => sendJson<Goal>("PATCH", `/mentorship/goals/${id(goalId)}`, body);
export const createIndicator = (engagementId: string, body: IndicatorBody) => sendJson<Indicator>("POST", `/mentorship/engagements/${id(engagementId)}/indicators`, body);
export const createActionItem = (engagementId: string, body: ActionItemBody) => sendJson<ActionItem>("POST", `/mentorship/engagements/${id(engagementId)}/action-items`, body);
export const updateActionItem = (itemId: string, body: { status: ActionItemStatus }) => sendJson<ActionItem>("PATCH", `/mentorship/action-items/${id(itemId)}`, body);
export const createSession = (engagementId: string, body: SessionBody) => sendJson<Session>("POST", `/mentorship/engagements/${id(engagementId)}/sessions`, body);
export const endEngagement = (engagementId: string, reason?: string) => sendJson<Engagement>("POST", `/mentorship/engagements/${id(engagementId)}/end`, reason ? { reason } : {});

// ---- Calls: the business owner ----

export const fetchMyEngagements = () => getJson<EngagementList>("/mentorship/my-engagements");
export const fetchMyEngagement = (engagementId: string) => getJson<OwnerView>(`/mentorship/my-engagements/${id(engagementId)}`);
export const consent = (engagementId: string) => sendJson<Engagement>("POST", `/mentorship/engagements/${id(engagementId)}/consent`);
export const decline = (engagementId: string) => sendJson<Engagement>("POST", `/mentorship/engagements/${id(engagementId)}/decline`);
export const completeMyItem = (itemId: string) => sendJson<ActionItem>("PATCH", `/mentorship/my-action-items/${id(itemId)}`, { status: "DONE" });
export const fetchMemberships = () => getJson<MembershipList>("/donor-projects/my-memberships");
export const setMembershipConsent = (membershipId: string, action: "consent" | "withdraw") => sendJson<Membership>("POST", `/donor-projects/my-memberships/${id(membershipId)}/${action}`);
export const fetchMembershipLog = (membershipId: string) => getJson<MembershipLog>(`/donor-projects/my-memberships/${id(membershipId)}/access-log`);

// ---- Queries ----

export const mentorshipKeys = {
  all: ["mentorship"] as const,
  engagements: () => ["mentorship", "engagements"] as const,
  dashboard: (engagementId: string) => ["mentorship", "dashboard", engagementId] as const,
  snapshot: (engagementId: string) => ["mentorship", "snapshot", engagementId] as const,
  actual: (indicatorId: string) => ["mentorship", "actual", indicatorId] as const,
  items: (engagementId: string) => ["mentorship", "items", engagementId] as const,
  sessions: (engagementId: string) => ["mentorship", "sessions", engagementId] as const,
  session: (sessionId: string) => ["mentorship", "session", sessionId] as const,
  cohort: () => ["mentorship", "cohort"] as const,
  mine: () => ["mentorship", "mine"] as const,
  myOne: (engagementId: string) => ["mentorship", "mine", engagementId] as const,
  memberships: () => ["mentorship", "memberships"] as const,
  membershipLog: (membershipId: string) => ["mentorship", "memberships", "log", membershipId] as const,
};

export const useEngagements = () => useQuery({ queryKey: mentorshipKeys.engagements(), queryFn: fetchEngagements, staleTime: 0 });
export const useDashboard = (engagementId: string) => useQuery({ queryKey: mentorshipKeys.dashboard(engagementId), queryFn: () => fetchDashboard(engagementId), staleTime: 0, retry: false });
export const useSnapshot = (engagementId: string) => useQuery({ queryKey: mentorshipKeys.snapshot(engagementId), queryFn: () => fetchSnapshot(engagementId), staleTime: 0, retry: false });
export const useActual = (indicatorId: string, enabled: boolean) => useQuery({ queryKey: mentorshipKeys.actual(indicatorId), queryFn: () => fetchActual(indicatorId), enabled, staleTime: 0, retry: false });
export const useSession = (sessionId: string) => useQuery({ queryKey: mentorshipKeys.session(sessionId), queryFn: () => fetchSession(sessionId), staleTime: 0 });
export const useCohort = () => useQuery({ queryKey: mentorshipKeys.cohort(), queryFn: fetchCohort, staleTime: 0 });
export const useMyEngagements = () => useQuery({ queryKey: mentorshipKeys.mine(), queryFn: fetchMyEngagements, staleTime: 0 });
export const useMyEngagement = (engagementId: string) => useQuery({ queryKey: mentorshipKeys.myOne(engagementId), queryFn: () => fetchMyEngagement(engagementId), staleTime: 0 });
export const useMemberships = () => useQuery({ queryKey: mentorshipKeys.memberships(), queryFn: fetchMemberships, staleTime: 0 });
export const useMembershipLog = (membershipId: string) => useQuery({ queryKey: mentorshipKeys.membershipLog(membershipId), queryFn: () => fetchMembershipLog(membershipId), staleTime: 0 });

/** One list per ACTIVE engagement, gathered — the API keeps action items and sessions per engagement. */
export function useAcrossEngagements<T>(engagements: readonly Engagement[], kind: "items" | "sessions") {
  return useQueries({
    queries: engagements.map((e) => ({
      queryKey: kind === "items" ? mentorshipKeys.items(e.id) : mentorshipKeys.sessions(e.id),
      queryFn: async () => ({ engagement: e, data: (kind === "items" ? (await fetchActionItems(e.id)).data : (await fetchSessions(e.id)).data) as unknown as T[] }),
      staleTime: 0,
    })),
  });
}

/** After any mentoring write: every mentorship read is stale. */
export function useInvalidateMentorship(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await client.invalidateQueries({ queryKey: mentorshipKeys.all });
  }, [client]);
}

// ---- Words ----

export const ENGAGEMENT_STATUS_LABEL: Readonly<Record<EngagementStatus, string>> = { INVITED: "Awaiting the owner’s consent", ACTIVE: "Active", ENDED: "Ended" };
export const GOAL_STATUS_LABEL: Readonly<Record<GoalStatus, string>> = { OPEN: "Open", ON_TRACK: "On track", AT_RISK: "At risk", MET: "Met", MISSED: "Missed" };
export const GOAL_STATUSES: readonly GoalStatus[] = ["OPEN", "ON_TRACK", "AT_RISK", "MET", "MISSED"];
/** MET and MISSED are final (the server refuses a change after them). */
export const GOAL_FINAL: ReadonlySet<GoalStatus> = new Set(["MET", "MISSED"]);
export const ITEM_STATUS_LABEL: Readonly<Record<ActionItemStatus, string>> = { OPEN: "Open", DONE: "Done", CANCELLED: "Cancelled" };
export const PARTY_LABEL: Readonly<Record<ActionParty, string>> = { MENTOR: "Mentor", ENTREPRENEUR: "Business owner" };

export const SOURCE_LABEL: Readonly<Record<SourceKey, string>> = {
  MONTHLY_REVENUE: "Monthly revenue",
  NET_PROFIT: "Net profit",
  CASH_POSITION: "Cash position",
  RECEIVABLES_OUTSTANDING: "Receivables outstanding",
  GROSS_MARGIN_PCT: "Gross margin (%)",
  SALES_GROWTH_PCT: "Sales growth (%)",
  INVENTORY_TURNOVER: "Inventory turnover (times)",
};
export const SOURCES: readonly SourceKey[] = ["MONTHLY_REVENUE", "NET_PROFIT", "CASH_POSITION", "RECEIVABLES_OUTSTANDING", "GROSS_MARGIN_PCT", "SALES_GROWTH_PCT", "INVENTORY_TURNOVER"];
/** A money KPI takes an amount target; the rest take a rate. */
export const MONEY_SOURCES: ReadonlySet<SourceKey> = new Set(["MONTHLY_REVENUE", "NET_PROFIT", "CASH_POSITION", "RECEIVABLES_OUTSTANDING"]);
/** Only these may target a negative figure. */
export const NEGATIVE_OK: ReadonlySet<SourceKey> = new Set(["NET_PROFIT", "SALES_GROWTH_PCT"]);
export const STANDING_LABEL: Readonly<Record<DashboardIndicator["standing"], string>> = { ON_TARGET: "On target", OFF_TARGET: "Off target", UNAVAILABLE: "Not available" };

export const CONSENT_LABEL: Readonly<Record<Membership["consentStatus"], string>> = { PENDING: "Awaiting your consent", CONSENTED: "Consented", WITHDRAWN: "Withdrawn" };

/** A target rate: a decimal string with at most 2 places, e.g. 35 or -5.5. */
export const RATE = /^-?\d{1,7}(\.\d{1,2})?$/;
