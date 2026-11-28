import { useQuery } from "@tanstack/react-query";
import type { paths } from "@/lib/api/schema";
import { apiFetch } from "@/lib/api/browser";
import { failureMessage, UNREACHABLE } from "@/lib/api/messages";
import { getJson, withParams } from "@/lib/api/request";
import { ApiHttpError } from "@/lib/dashboard/fetch";

// T-B4 — A BUSINESS EXPORTS ITS OWN RECORDS (M4.5 Wave 4). The screen reads the curated report
// library (GET /v1/report-library: only the reports this role may run, each with its filters),
// shows a report with the chosen filters, and exports EXACTLY that filtered view as .xlsx, .csv or
// .pdf. The server decides everything: the figures, what a role may see, and whether a file comes
// back at once or is built in the background (202) to collect from "Your exports". Money arrives
// as strings of cents; the screen only formats it.
//
// TWO LIBRARIES, ONE SCREEN (M4.5 W5): every call takes the library — "tenant" (the business's own,
// /v1/report-library, the default) or "platform" (the Command Center's reporting center,
// /v1/platform-reports, platform staff only; donor figures stay consent-gated by the server).

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;

export type Catalogue = Json<paths["/v1/report-library/"]["get"]["responses"][200]>;
export type ReportEntry = Catalogue["data"][number];
export type FilterSpec = ReportEntry["filters"][number];
export type ReportView = Json<paths["/v1/report-library/{id}"]["get"]["responses"][200]>;
export type ViewSection = ReportView["sections"][number];
export type ExportRow = Json<paths["/v1/report-library/exports/{id}"]["get"]["responses"][200]>;
export type ExportFormat = "xlsx" | "csv" | "pdf";
export type Filters = Readonly<Record<string, string>>;

export const FORMAT_LABEL: Readonly<Record<ExportFormat, string>> = { xlsx: "Excel (.xlsx)", csv: "CSV", pdf: "PDF" };

export const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  platform: "Businesses, applications and people",
  donor: "Programmes and mentoring",
  operations: "Sales, stock and purchasing",
  financial: "Financial statements and balances",
  payroll: "Payroll",
  integrations: "M-Pesa and eTIMS",
  mentorship: "Mentoring and programmes",
};

export type Library = "tenant" | "platform";
const BASES: Readonly<Record<Library, string>> = { tenant: "/report-library", platform: "/platform-reports" };
const PAGE = 50;

/** Only the filters that are set — an empty one is the report's stated default. */
export function cleanFilters(filters: Filters): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, value.trim() === "" ? undefined : value.trim()]));
}

export const fetchCatalogue = (library: Library = "tenant") => getJson<Catalogue>(`${BASES[library]}/`);
export const fetchReport = (id: string, filters: Filters, page: number, library: Library = "tenant") =>
  getJson<ReportView>(withParams(`${BASES[library]}/${encodeURIComponent(id)}`, { ...cleanFilters(filters), take: String(PAGE), skip: String(page * PAGE) }));
export const fetchExports = (library: Library = "tenant") => getJson<{ data: ExportRow[] }>(`${BASES[library]}/exports`);
export const fetchExport = (id: string, library: Library = "tenant") => getJson<ExportRow>(`${BASES[library]}/exports/${encodeURIComponent(id)}`);
export const REPORT_PAGE_SIZE = PAGE;

export type ExportResult = { kind: "file"; filename: string; blob: Blob } | { kind: "background"; export: ExportRow };

async function binary(path: string): Promise<Response> {
  let response: Response;
  try {
    response = await apiFetch(path);
  } catch {
    throw new ApiHttpError(0, UNREACHABLE);
  }
  if (response.status === 200 || response.status === 202) return response;
  const body: unknown = await response.json().catch(() => null);
  const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : null;
  throw new ApiHttpError(response.status, failureMessage(response.status, message));
}

function filenameOf(response: Response, fallback: string): string {
  const header = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? fallback;
}

/** Exports the filtered report: the file itself when small, or a background export to collect. */
export async function exportReport(id: string, format: ExportFormat, filters: Filters, library: Library = "tenant"): Promise<ExportResult> {
  const response = await binary(withParams(`${BASES[library]}/${encodeURIComponent(id)}/export`, { ...cleanFilters(filters), format }));
  if (response.status === 202) return { kind: "background", export: (await response.json()) as ExportRow };
  return { kind: "file", filename: filenameOf(response, `${id}.${format}`), blob: await response.blob() };
}

export async function downloadExport(row: ExportRow, library: Library = "tenant"): Promise<{ filename: string; blob: Blob }> {
  const response = await binary(`${BASES[library]}/exports/${encodeURIComponent(row.id)}/download`);
  return { filename: filenameOf(response, row.filename ?? `${row.reportId}.${row.format}`), blob: await response.blob() };
}

/** Hands a file to the browser to save. */
export function saveFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export const exportKeys = {
  all: ["exports"] as const,
  catalogue: (library: Library = "tenant") => ["exports", library, "catalogue"] as const,
  report: (id: string, filters: Filters, page: number, library: Library = "tenant") => ["exports", library, "report", id, filters, page] as const,
  mine: (library: Library = "tenant") => ["exports", library, "mine"] as const,
};

export function useCatalogue(library: Library = "tenant") {
  return useQuery({ queryKey: exportKeys.catalogue(library), queryFn: () => fetchCatalogue(library) });
}

export function useReport(id: string | null, filters: Filters | null, page: number, library: Library = "tenant") {
  return useQuery({
    queryKey: exportKeys.report(id ?? "", filters ?? {}, page, library),
    queryFn: () => fetchReport(id ?? "", filters ?? {}, page, library),
    enabled: id !== null && filters !== null,
    staleTime: 0,
  });
}

/** Your background exports; refreshed while any is still being prepared. */
export function useMyExports(library: Library = "tenant") {
  return useQuery({
    queryKey: exportKeys.mine(library),
    queryFn: () => fetchExports(library),
    refetchInterval: (query) => (query.state.data?.data.some((row) => row.status === "PENDING") ? 2_000 : false),
  });
}
