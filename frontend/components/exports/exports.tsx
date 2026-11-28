"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, FileText, ShieldAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { FormAlert } from "@/components/auth/form-bits";
import { Greeting } from "@/components/shell/greeting";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, ProductPicker, SELECT_CLASS, type PickedProduct } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getJson } from "@/lib/api/request";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDate, formatDateTime } from "@/lib/datetime";
import {
  CATEGORY_LABEL,
  downloadExport,
  exportKeys,
  exportReport,
  FORMAT_LABEL,
  REPORT_PAGE_SIZE,
  saveFile,
  useCatalogue,
  useMyExports,
  useReport,
  type ExportFormat,
  type ExportRow,
  type FilterSpec,
  type Filters,
  type Library,
  type ReportEntry,
  type ViewSection,
} from "@/lib/exports/exports";
import { formatKES } from "@/lib/money";

// T-B4 — REPORTS & EXPORTS: a business exports its OWN records. Choose a report (only the ones
// this role may run are listed — the server decides), set its filters, look at the result, and
// export EXACTLY what is shown as Excel, CSV or PDF. A large export is prepared in the background
// and collected from "Your exports", downloadable by you alone for 30 minutes. Every export is
// recorded; payroll and identity reports are flagged confidential.

interface Option {
  value: string;
  label: string;
}

/** The choices for an entity filter, from the API the role may already read; null when it may not. */
function useEntityOptions(entity: string | undefined): Option[] | null {
  const [options, setOptions] = useState<Option[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const path =
      entity === "location"
        ? "/locations"
        : entity === "customer"
          ? "/customers"
          : entity === "supplier"
            ? "/inventory/suppliers"
            : entity === "payrollRun"
              ? "/payroll/runs"
              : entity === "tenant"
                ? "/tenants"
                : null;
    if (path === null) return;
    getJson<{ data: Array<Record<string, unknown>> }>(path)
      .then((body) => {
        if (cancelled) return;
        setOptions(
          body.data.map((row) => ({
            value: String(row.id),
            label:
              entity === "payrollRun"
                ? `Run ${String(row.runNumber)} — ${String(row.periodYear)}-${String(row.periodMonth).padStart(2, "0")}`
                : String(row.name ?? row.id),
          })),
        );
      })
      .catch(() => {
        // A list this role may not read: the filter is simply not offered.
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [entity]);
  return options;
}

function FilterField({ spec, value, onChange }: { spec: FilterSpec; value: string; onChange: (value: string) => void }) {
  const id = useId();
  const entityOptions = useEntityOptions(spec.type === "entity" && spec.entity !== "product" ? spec.entity : undefined);
  const [product, setProduct] = useState<PickedProduct | null>(null);
  const hint = spec.defaultHint ? `Left empty: ${spec.defaultHint}.` : undefined;

  if (spec.type === "entity" && spec.entity === "product") {
    return (
      <ProductPicker
        label={spec.label}
        value={product}
        onChange={(picked) => {
          setProduct(picked);
          onChange(picked?.id ?? "");
        }}
      />
    );
  }
  if (spec.type === "entity") {
    if (entityOptions !== null && entityOptions.length === 0 && !spec.required) return null;
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{spec.label}</Label>
        <select id={id} className={SELECT_CLASS} value={value} onChange={(e) => onChange(e.target.value)} disabled={entityOptions === null}>
          <option value="">{spec.required ? `Choose ${spec.label.toLowerCase()}` : "Any"}</option>
          {(entityOptions ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (spec.type === "select") {
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{spec.label}</Label>
        <select id={id} className={SELECT_CLASS} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Any</option>
          {(spec.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{spec.label}</Label>
      <Input
        id={id}
        className="h-11"
        type={spec.type === "date" ? "date" : spec.type === "number" ? "number" : "search"}
        inputMode={spec.type === "number" ? "numeric" : undefined}
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function cell(kind: string, value: string | null): string {
  if (value === null) return "";
  if (kind === "money") return formatKES(value);
  if (kind === "date") return formatDate(value);
  if (kind === "datetime") return formatDateTime(value);
  return value;
}

function SectionTable({ section }: { section: ViewSection }) {
  const numeric = (kind: string) => kind !== "text" && kind !== "date" && kind !== "datetime";
  return (
    <section aria-label={`Results: ${section.name}`} className="space-y-2">
      <h3 className="font-medium">
        {section.name} <span className="text-sm font-normal text-muted-foreground">({section.totalRows.toString()} {section.totalRows === 1 ? "row" : "rows"})</span>
      </h3>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {section.columns.map((c) => (
                <th key={c.key} scope="col" className={`whitespace-nowrap px-3 py-2 font-medium ${numeric(c.kind) ? "text-right" : "text-left"}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {section.rows.map((row, i) => (
              <tr key={i.toString()}>
                {section.columns.map((c) => (
                  <td key={c.key} className={`px-3 py-1.5 ${numeric(c.kind) ? "text-right tabular-nums" : ""}`}>
                    {cell(c.kind, row[c.key] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {section.totals ? (
            <tfoot className="border-t-2 font-semibold">
              <tr>
                {section.columns.map((c, i) => (
                  <td key={c.key} className={`px-3 py-1.5 ${numeric(c.kind) ? "text-right tabular-nums" : ""}`}>
                    {section.totals?.[c.key] !== undefined ? cell(c.kind, section.totals[c.key] ?? null) : i === 0 ? "Total" : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {section.note ? <p className="text-xs text-muted-foreground">{section.note}</p> : null}
    </section>
  );
}

const EXPORT_STATUS: Record<string, string> = { PENDING: "Being prepared…", READY: "Ready to download", FAILED: "Failed", EXPIRED: "Expired — run it again" };

function MyExports({ reportTitles, library }: { reportTitles: Map<string, string>; library: Library }) {
  const mine = useMyExports(library);
  const [error, setError] = useState<string | null>(null);
  if (mine.isPending) return <LoadingState label="Loading your exports" lines={2} />;
  if (mine.isError) return <ErrorState title="Couldn’t load your exports" description={mine.error.message} onRetry={() => void mine.refetch()} />;
  if (mine.data.data.length === 0) return <p className="text-sm text-muted-foreground">Large exports you start appear here while they are prepared.</p>;
  return (
    <div className="space-y-2">
      {error ? <FormAlert id="my-exports-error">{error}</FormAlert> : null}
      <ul aria-label="Your exports" className="divide-y rounded-md border">
        {mine.data.data.map((row: ExportRow) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span>
              <span className="font-medium">{reportTitles.get(row.reportId) ?? row.reportId}</span> ({FORMAT_LABEL[row.format as ExportFormat] ?? row.format}, {row.rowCount.toString()} rows)
              <span className="block text-muted-foreground">
                {EXPORT_STATUS[row.status] ?? row.status} — started {formatDateTime(row.createdAt)}
                {row.status === "READY" ? `, until ${formatDateTime(row.expiresAt)}` : ""}
                {row.status === "FAILED" && row.error ? `: ${row.error}` : ""}
              </span>
            </span>
            {row.status === "READY" ? (
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => {
                  setError(null);
                  downloadExport(row, library)
                    .then((file) => saveFile(file.filename, file.blob))
                    .catch((failure: unknown) => setError(failure instanceof ApiHttpError ? failure.message : "The download failed. Try again."));
                }}
              >
                <Download aria-hidden /> Download
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReportPanel({ report, library, initialFilters }: { report: ReportEntry; library: Library; initialFilters?: Filters }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({ ...initialFilters });
  const [applied, setApplied] = useState<Filters | null>(report.filters.some((f) => f.required && !(initialFilters?.[f.key] ?? "").trim()) ? null : { ...initialFilters });
  const [page, setPage] = useState(0);
  const view = useReport(report.id, applied, page, library);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const missing = report.filters.filter((f) => f.required && (draft[f.key] ?? "").trim() === "");

  async function runExport(format: ExportFormat) {
    if (applied === null) return;
    setBusy(format);
    setNotice(null);
    setError(null);
    try {
      const result = await exportReport(report.id, format, applied, library);
      if (result.kind === "file") {
        saveFile(result.filename, result.blob);
        setNotice(`Saved ${result.filename} — exactly the rows shown, with the filters printed on it. The export is recorded.`);
      } else {
        setNotice(`This export has ${result.export.rowCount.toString()} rows, so it is being prepared. It will appear under “Your exports” below, ready to download for 30 minutes.`);
        await client.invalidateQueries({ queryKey: exportKeys.mine(library) });
      }
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The export failed. Nothing was saved — try again.");
    } finally {
      setBusy(null);
    }
  }

  const largest = view.data ? Math.max(0, ...view.data.sections.map((s) => s.totalRows)) : 0;
  return (
    <section aria-labelledby="report-title" className="space-y-4 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 id="report-title" className="font-display text-xl font-semibold">
          {report.title}
        </h2>
        <p className="text-sm text-muted-foreground">{report.description}</p>
      </div>
      {report.sensitive ? (
        <p className="flex gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          Confidential: this report holds personal or pay details. Share it only with people entitled to see it — every export is recorded.
        </p>
      ) : null}
      {report.filters.length > 0 ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (missing.length > 0) {
              setError(`Choose ${missing.map((f) => f.label.toLowerCase()).join(" and ")} first.`);
              return;
            }
            setError(null);
            setPage(0);
            setApplied({ ...draft });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {report.filters.map((spec) => (
              <FilterField key={spec.key} spec={spec} value={draft[spec.key] ?? ""} onChange={(value) => setDraft((now) => ({ ...now, [spec.key]: value }))} />
            ))}
          </div>
          <Button type="submit" className="h-11">
            Show report
          </Button>
        </form>
      ) : null}
      {error ? <FormAlert id="report-error">{error}</FormAlert> : null}
      {notice ? <Done>{notice}</Done> : null}
      {applied === null ? (
        <p className="text-sm text-muted-foreground">Choose the filters above, then show the report.</p>
      ) : view.isPending ? (
        <LoadingState label="Running the report" />
      ) : view.isError ? (
        <ErrorState title="Couldn’t run the report" description={view.error.message} onRetry={() => void view.refetch()} />
      ) : (
        <div className="space-y-4">
          <div className="space-y-1 text-sm">
            {view.data.period ? (
              <p>
                <span className="font-medium">Period:</span> {formatDate(view.data.period.from)} to {formatDate(view.data.period.to)}
              </p>
            ) : null}
            {view.data.filters.map((f) => (
              <p key={f.label}>
                <span className="font-medium">{f.label}:</span> {f.value}
              </p>
            ))}
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Export">
            {(["xlsx", "csv", "pdf"] as const).map((format) => (
              <Button key={format} type="button" variant="outline" className="h-11" disabled={busy !== null} onClick={() => void runExport(format)}>
                {format === "pdf" ? <FileText aria-hidden /> : <FileSpreadsheet aria-hidden />}
                {busy === format ? "Exporting…" : `Export ${FORMAT_LABEL[format]}`}
              </Button>
            ))}
          </div>
          {view.data.sections.map((section) => (
            <SectionTable key={section.name} section={section} />
          ))}
          {largest > REPORT_PAGE_SIZE ? (
            <div className="flex items-center gap-2 text-sm">
              <Button type="button" variant="outline" className="h-11" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span>
                Page {(page + 1).toString()} of {Math.ceil(largest / REPORT_PAGE_SIZE).toString()} — the export always holds every row.
              </span>
              <Button type="button" variant="outline" className="h-11" disabled={(page + 1) * REPORT_PAGE_SIZE >= largest} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

const COPY: Readonly<Record<Library, { title: string; intro: string; loading: string; none: string; noneHint: string }>> = {
  tenant: {
    title: "Reports & exports",
    intro: "Your business’s own records, as Excel, CSV or PDF. Filter a report, check it, then export exactly what you see.",
    loading: "Loading your reports",
    none: "No reports for your role",
    noneHint: "Ask the business owner if you need one.",
  },
  platform: {
    title: "Reporting center",
    intro: "Platform reports — businesses, applications, people, programmes and operations. Filter, check, then export exactly what you see. Donor figures count consenting businesses only.",
    loading: "Loading the platform reports",
    none: "No platform reports for your role",
    noneHint: "A super-administrator can see every report.",
  },
};

export function Exports({ library = "tenant", initialReport, initialFilters }: { library?: Library; initialReport?: string; initialFilters?: Filters } = {}) {
  const catalogue = useCatalogue(library);
  const copy = COPY[library];
  const [selected, setSelected] = useState<string | null>(initialReport ?? null);
  const reports = catalogue.data?.data ?? [];
  const report = reports.find((r) => r.id === selected) ?? null;
  const categories = [...new Set(reports.map((r) => r.category))];
  const titles = new Map(reports.map((r) => [r.id, r.title]));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Greeting />
        <h1 className="font-display text-2xl font-semibold">{copy.title}</h1>
        <p className="text-sm text-muted-foreground">{copy.intro}</p>
      </div>
      {catalogue.isPending ? <LoadingState label={copy.loading} /> : null}
      {catalogue.isError ? <ErrorState title="Couldn’t load your reports" description={catalogue.error.message} onRetry={() => void catalogue.refetch()} /> : null}
      {catalogue.isSuccess && reports.length === 0 ? <EmptyState title={copy.none} description={copy.noneHint} /> : null}
      {catalogue.isSuccess && reports.length > 0 ? (
        <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav aria-label="Reports" className="space-y-4">
            {categories.map((category) => (
              <div key={category} className="space-y-1">
                <h2 className="text-sm font-semibold text-muted-foreground">{CATEGORY_LABEL[category] ?? category}</h2>
                <ul className="space-y-1">
                  {reports
                    .filter((r) => r.category === category)
                    .map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          aria-current={r.id === selected ? "true" : undefined}
                          onClick={() => setSelected(r.id)}
                          className={`flex min-h-11 w-full items-center rounded-md px-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${r.id === selected ? "bg-accent font-medium" : ""}`}
                        >
                          {r.title}
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </nav>
          <div className="min-w-0 space-y-6">
            {report ? (
              <ReportPanel key={report.id} report={report} library={library} initialFilters={report.id === initialReport ? initialFilters : undefined} />
            ) : (
              <EmptyState title="Choose a report" description="Pick one on the left to see it and export it." />
            )}
            <section aria-labelledby="my-exports-title" className="space-y-2">
              <h2 id="my-exports-title" className="font-semibold">
                Your exports
              </h2>
              <MyExports reportTitles={titles} library={library} />
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}
