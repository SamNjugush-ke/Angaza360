import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, sendJson, withParams } from "@/lib/api/request";
import type { Role } from "@/lib/auth/landing";

// Payroll (/v1/payroll): the employee master, monthly runs (DRAFT → APPROVED → POSTED → PAID),
// payslips and their printable document, the net-pay settlement, the four statutory schedules and
// remittances, and the muster roll. EVERY FIGURE IS THE SERVER'S — the gross-to-net engine, the
// statutory ruleset in force, what is owed to each authority. This layer only carries values:
// shillings on requests, cents strings on responses.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<T> = T extends { requestBody: { content: { "application/json": infer B } } } ? B : never;

export type EmployeeList = Json<paths["/v1/payroll/employees"]["get"]["responses"][200]>;
export type Employee = Json<paths["/v1/payroll/employees/{id}"]["get"]["responses"][200]>;
export type EmployeeBody = Body<paths["/v1/payroll/employees"]["post"]>;
export type EmployeeUpdate = Body<paths["/v1/payroll/employees/{id}"]["patch"]>;
export type EmployeeStatus = Employee["status"];
export type EmploymentType = Employee["employmentType"];
export type PayMethod = Employee["paymentMethod"];
export type RunList = Json<paths["/v1/payroll/runs"]["get"]["responses"][200]>;
export type Run = RunList["data"][number];
export type RunDetail = Json<paths["/v1/payroll/runs/{id}"]["get"]["responses"][200]>;
export type RunStatus = Run["status"];
export type Payslip = RunDetail["payslips"][number];
export type PayslipDocument = Json<paths["/v1/payroll/payslips/{id}/document"]["get"]["responses"][200]>;
export type NetPayment = Json<paths["/v1/payroll/runs/{id}/net-payment"]["get"]["responses"][200]>;
export type SettlementMethod = NetPayment["method"];
export type SettleBody = Body<paths["/v1/payroll/runs/{id}/settle-net"]["post"]>;
export type Remittance = Json<paths["/v1/payroll/remittances/{id}"]["get"]["responses"][200]>;
export type RemittanceList = Json<paths["/v1/payroll/remittances"]["get"]["responses"][200]>;
export type RemittanceBody = Body<paths["/v1/payroll/remittances"]["post"]>;
export type StatutoryType = Remittance["statutoryType"];
export type StatutorySummary = Json<paths["/v1/payroll/runs/{id}/statutory-summary"]["get"]["responses"][200]>;
export type Muster = Json<paths["/v1/payroll/runs/{id}/muster"]["get"]["responses"][200]>;

// ---- Who may do what (the API's guards, routes/payroll.ts) ----

const has = (roles: readonly Role[]) => (role: Role) => roles.includes(role);
export const payrollPermissions = (role: Role) => ({
  /** Every read, payslips included (a recorded product decision: the accountant and auditor read pay). */
  canRead: has(["MSME_OWNER", "MSME_MANAGER", "HR_OFFICER", "ACCOUNTANT", "VIEWER_AUDITOR"])(role),
  /** The employee master, and creating / recomputing a DRAFT run — HR work that posts nothing. */
  canHr: has(["MSME_OWNER", "MSME_MANAGER", "HR_OFFICER"])(role),
  /** Approve, post, cancel, settle net pay, remit — money leaving or owed. */
  canApprove: has(["MSME_OWNER", "MSME_MANAGER"])(role),
});
export type PayrollPermissions = ReturnType<typeof payrollPermissions>;

// ---- Calls ----

const id = (value: string) => encodeURIComponent(value);
export const fetchEmployees = (status: EmployeeStatus | "") => getJson<EmployeeList>(withParams("/payroll/employees", { status: status || undefined }));
export const fetchEmployee = (employeeId: string) => getJson<Employee>(`/payroll/employees/${id(employeeId)}`);
export const createEmployee = (body: EmployeeBody) => sendJson<Employee>("POST", "/payroll/employees", body);
export const updateEmployee = (employeeId: string, body: EmployeeUpdate) => sendJson<Employee>("PATCH", `/payroll/employees/${id(employeeId)}`, body);
export const setEmployeeStatus = (employeeId: string, body: { status: EmployeeStatus; terminationDate?: string }) =>
  sendJson<Employee>("PATCH", `/payroll/employees/${id(employeeId)}/status`, body);

export const fetchRuns = (status: RunStatus | "") => getJson<RunList>(withParams("/payroll/runs", { status: status || undefined }));
export const fetchRun = (runId: string) => getJson<RunDetail>(`/payroll/runs/${id(runId)}`);
export const createRun = (body: { periodYear: number; periodMonth: number; payDate: string; notes?: string }) => sendJson<RunDetail>("POST", "/payroll/runs", body);
export const recomputeRun = (runId: string) => sendJson<RunDetail>("POST", `/payroll/runs/${id(runId)}/recompute`);
export const approveRun = (runId: string) => sendJson<RunDetail>("POST", `/payroll/runs/${id(runId)}/approve`);
export const postRun = (runId: string) => sendJson<RunDetail>("POST", `/payroll/runs/${id(runId)}/post`);
export const cancelRun = (runId: string, reason: string) => sendJson<RunDetail>("POST", `/payroll/runs/${id(runId)}/cancel`, { reason });

export const fetchPayslipDocument = (payslipId: string) => getJson<PayslipDocument>(`/payroll/payslips/${id(payslipId)}/document`);
export const settleNet = (runId: string, body: SettleBody) => sendJson<NetPayment>("POST", `/payroll/runs/${id(runId)}/settle-net`, body);
export const fetchNetPayment = (runId: string) => getJson<NetPayment>(`/payroll/runs/${id(runId)}/net-payment`);
export const fetchStatutorySummary = (runId: string) => getJson<StatutorySummary>(`/payroll/runs/${id(runId)}/statutory-summary`);
export const fetchMuster = (runId: string) => getJson<Muster>(`/payroll/runs/${id(runId)}/muster`);
export const remit = (body: RemittanceBody) => sendJson<Remittance>("POST", "/payroll/remittances", body);
export const fetchRemittances = (filters: { statutoryType?: StatutoryType | ""; payrollRunId?: string }) =>
  getJson<RemittanceList>(withParams("/payroll/remittances", { statutoryType: filters.statutoryType || undefined, payrollRunId: filters.payrollRunId }));

// ---- Queries ----

export const payrollKeys = {
  all: ["payroll"] as const,
  employees: (status: string) => ["payroll", "employees", status] as const,
  employee: (employeeId: string) => ["payroll", "employee", employeeId] as const,
  runs: (status: string) => ["payroll", "runs", status] as const,
  run: (runId: string) => ["payroll", "run", runId] as const,
  payslip: (payslipId: string) => ["payroll", "payslip", payslipId] as const,
  net: (runId: string) => ["payroll", "net", runId] as const,
  summary: (runId: string) => ["payroll", "summary", runId] as const,
  muster: (runId: string) => ["payroll", "muster", runId] as const,
  remittances: (filters: string) => ["payroll", "remittances", filters] as const,
};

export const useEmployees = (status: EmployeeStatus | "") => useQuery({ queryKey: payrollKeys.employees(status), queryFn: () => fetchEmployees(status), staleTime: 0 });
export const useEmployee = (employeeId: string) => useQuery({ queryKey: payrollKeys.employee(employeeId), queryFn: () => fetchEmployee(employeeId), staleTime: 0 });
export const useRuns = (status: RunStatus | "") => useQuery({ queryKey: payrollKeys.runs(status), queryFn: () => fetchRuns(status), staleTime: 0 });
export const useRun = (runId: string) => useQuery({ queryKey: payrollKeys.run(runId), queryFn: () => fetchRun(runId), staleTime: 0 });
export const usePayslipDocument = (payslipId: string) => useQuery({ queryKey: payrollKeys.payslip(payslipId), queryFn: () => fetchPayslipDocument(payslipId), staleTime: 0 });
export const useNetPayment = (runId: string, enabled: boolean) => useQuery({ queryKey: payrollKeys.net(runId), queryFn: () => fetchNetPayment(runId), enabled, staleTime: 0 });
export const useStatutorySummary = (runId: string) => useQuery({ queryKey: payrollKeys.summary(runId), queryFn: () => fetchStatutorySummary(runId), staleTime: 0 });
export const useMuster = (runId: string) => useQuery({ queryKey: payrollKeys.muster(runId), queryFn: () => fetchMuster(runId), staleTime: 0 });
export const fetchRemittance = (remittanceId: string) => getJson<Remittance>(`/payroll/remittances/${id(remittanceId)}`);
export const useRemittance = (remittanceId: string) => useQuery({ queryKey: ["payroll", "remittance", remittanceId], queryFn: () => fetchRemittance(remittanceId), staleTime: 0 });
export const useRemittances = (filters: { statutoryType?: StatutoryType | ""; payrollRunId?: string }) =>
  useQuery({ queryKey: payrollKeys.remittances(JSON.stringify(filters)), queryFn: () => fetchRemittances(filters), staleTime: 0 });

/** After any payroll write: every payroll read is stale, and so are the books (an accrual, a settlement or a remittance posts). */
export function useInvalidatePayroll(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await Promise.all([client.invalidateQueries({ queryKey: payrollKeys.all }), client.invalidateQueries({ queryKey: ["accounting"] }), client.invalidateQueries({ queryKey: ["dashboard"] })]);
  }, [client]);
}

// ---- Words ----

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
export const periodName = (year: number, month: number) => `${MONTHS[month - 1] ?? month.toString()} ${year.toString()}`;

export const RUN_STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  DRAFT: "Draft",
  APPROVED: "Approved",
  POSTED: "Posted — net pay owed",
  PAID: "Paid",
  CANCELLED: "Cancelled",
};
export const RUN_STATUS_MEANING: Readonly<Record<RunStatus, string>> = {
  DRAFT: "Computed, nothing posted. Recompute it after changing an employee’s terms; approve it when it is right.",
  APPROVED: "Checked and approved. Posting books the salary cost and what is owed to staff and the authorities.",
  POSTED: "The accrual is in the books. Next: pay the net pay, and remit each statutory head when it falls due.",
  PAID: "Net pay has been paid. The statutory heads are remitted on each authority’s own calendar.",
  CANCELLED: "Withdrawn before posting. Nothing was booked; the month is free for a new run.",
};
export const RUN_STATUS_ORDER: readonly RunStatus[] = ["DRAFT", "APPROVED", "POSTED", "PAID", "CANCELLED"];

export const EMPLOYEE_STATUS_LABEL: Readonly<Record<EmployeeStatus, string>> = { ACTIVE: "Active", SUSPENDED: "Suspended", TERMINATED: "Terminated" };
export const EMPLOYMENT_TYPE_LABEL: Readonly<Record<EmploymentType, string>> = { PERMANENT: "Permanent", CONTRACT: "Contract", CASUAL: "Casual" };
export const PAY_METHOD_LABEL: Readonly<Record<PayMethod, string>> = { BANK: "Bank transfer", MPESA: "M-Pesa", CASH: "Cash" };
export const SETTLEMENT_LABEL: Readonly<Record<SettlementMethod, string>> = { BANK: "Bank (account 1020)", MPESA: "M-Pesa till (account 1010)", CASH: "Cash (account 1000)" };

export const HEADS: readonly StatutoryType[] = ["PAYE", "NSSF", "SHIF", "HOUSING_LEVY"];
export const HEAD_LABEL: Readonly<Record<StatutoryType, string>> = { PAYE: "PAYE", NSSF: "NSSF", SHIF: "SHIF", HOUSING_LEVY: "Housing levy" };
/** The statutory-summary key each head's schedule sits under. */
export const HEAD_KEY: Readonly<Record<StatutoryType, "paye" | "nssf" | "shif" | "housingLevy">> = { PAYE: "paye", NSSF: "nssf", SHIF: "shif", HOUSING_LEVY: "housingLevy" };
export const IDENTIFIER_LABEL: Readonly<Record<"kraPin" | "nssfNumber" | "shifNumber", string>> = { kraPin: "KRA PIN", nssfNumber: "NSSF number", shifNumber: "SHIF number" };
