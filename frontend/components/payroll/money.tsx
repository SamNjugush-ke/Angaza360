"use client";

import { ArrowLeft } from "lucide-react";
import { useId, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import { HEAD_LABEL, HEADS, SETTLEMENT_LABEL, useRemittance, useRemittances, type PayrollPermissions, type RunDetail, type StatutoryType } from "@/lib/payroll/payroll";
import { MusterView, PayslipDocumentView, Settlement, StatutorySummaryView } from "./documents";
import type { RunExtras } from "./runs";

// What follows a run once it exists: its documents (muster roll, statutory schedules, each payslip)
// and — once posted — paying net pay and remitting each statutory head. And the list of every
// remittance made, across runs.

type Panel = "statutory" | "muster" | null;

function RunPanels({ run, permissions }: { run: RunDetail; permissions: PayrollPermissions }) {
  const [panel, setPanel] = useState<Panel>(null);
  const posted = run.status === "POSTED" || run.status === "PAID";
  if (run.status === "CANCELLED") return null;
  return (
    <div className="space-y-4 border-t pt-4">
      <Settlement run={run} permissions={permissions} />
      <div className="no-print flex flex-col gap-2 sm:flex-row">
        <Button type="button" variant={panel === "statutory" ? "default" : "outline"} className="h-11" aria-pressed={panel === "statutory"} onClick={() => setPanel(panel === "statutory" ? null : "statutory")}>
          {posted ? "Statutory schedules & remittances" : "Statutory schedules"}
        </Button>
        <Button type="button" variant={panel === "muster" ? "default" : "outline"} className="h-11" aria-pressed={panel === "muster"} onClick={() => setPanel(panel === "muster" ? null : "muster")}>
          Muster roll
        </Button>
      </div>
      {panel === "statutory" ? <StatutorySummaryView runId={run.id} permissions={permissions} /> : null}
      {panel === "muster" ? <MusterView runId={run.id} /> : null}
    </div>
  );
}

export function runExtras(permissions: PayrollPermissions): RunExtras {
  return {
    renderAfter: (run) => <RunPanels run={run} permissions={permissions} />,
    renderPayslip: (payslipId, back) => (
      <div className="space-y-3">
        <Button type="button" variant="outline" className="no-print h-11" onClick={back}>
          <ArrowLeft className="size-4" aria-hidden /> Back to the run
        </Button>
        <PayslipDocumentView payslipId={payslipId} />
      </div>
    ),
  };
}

function RemittanceDetail({ remittanceId }: { remittanceId: string }) {
  const remittance = useRemittance(remittanceId);
  if (remittance.isPending) return <LoadingState label="Loading the remittance" lines={4} />;
  if (remittance.isError) return <ErrorState title="Couldn’t load the remittance" description={remittance.error.message} onRetry={() => void remittance.refetch()} />;
  const r = remittance.data;
  const facts: Array<[string, string]> = [
    ["Head", HEAD_LABEL[r.statutoryType]],
    ["Paid to", r.authority],
    ["Amount", `KES ${formatKES(r.amount)}`],
    ["Date paid", formatDate(r.remittanceDate)],
    ["Paid from", SETTLEMENT_LABEL[r.method]],
    ["Books", `Dr ${r.debitAccountCode} / Cr ${r.creditAccountCode}`],
    ["Payroll run", r.payrollRunNumber === null ? "Not tied to a run (arrears or several months)" : `Run ${r.payrollRunNumber.toString()}`],
    ["Authority’s reference", r.reference ?? "None"],
    ["Recorded", formatDateTime(r.createdAt)],
  ];
  return (
    <dl aria-label="Remittance" className="text-sm">
      {facts.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RemittancesView() {
  const headId = useId();
  const [head, setHead] = useState<StatutoryType | "">("");
  const remittances = useRemittances({ statutoryType: head });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="sm:w-56">
        <SelectField id={headId} label="Head" value={head} onChange={(v) => setHead(v as StatutoryType | "")}>
          <option value="">Every head</option>
          {HEADS.map((h) => (
            <option key={h} value={h}>
              {HEAD_LABEL[h]}
            </option>
          ))}
        </SelectField>
      </div>
      {remittances.isPending ? <LoadingState label="Loading remittances" lines={4} /> : null}
      {remittances.isError ? <ErrorState title="Couldn’t load the remittances" description={remittances.error.message} onRetry={() => void remittances.refetch()} /> : null}
      {remittances.isSuccess && remittances.data.data.length === 0 ? (
        <EmptyState title="No remittances yet" description="Remit PAYE, NSSF, SHIF or the housing levy from a posted run’s statutory schedules." />
      ) : null}
      {remittances.isSuccess && remittances.data.data.length > 0 ? (
        <ul aria-label="Remittances" className="space-y-2">
          {remittances.data.data.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setOpen(r.id)}
                className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>
                  <span className="font-medium">
                    {HEAD_LABEL[r.statutoryType]} to {r.authority}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {formatDate(r.remittanceDate)} · {SETTLEMENT_LABEL[r.method]}
                    {r.payrollRunNumber !== null ? ` · run ${r.payrollRunNumber.toString()}` : ""}
                  </span>
                </span>
                <span className="tabular-nums">KES {formatKES(r.amount)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <Sheet key={open} title="Statutory remittance" onClose={() => setOpen(null)}>
          <RemittanceDetail remittanceId={open} />
        </Sheet>
      ) : null}
    </div>
  );
}
