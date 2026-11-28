"use client";

import { Download, Upload } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField, TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { formatDateTime } from "@/lib/datetime";
import {
  APPLICATION_STATUS_LABEL,
  STAFF_STATUSES,
  commitBatch,
  editRow,
  fetchTemplate,
  removeRow,
  SOURCE_LABEL,
  uploadBatch,
  useApplications,
  useBatch,
  useInvalidateAdmin,
  type AdminPermissions,
  type ApplicationSource,
  type ApplicationStatus,
  type PreviewRow,
} from "@/lib/admin/admin";
import { ApplicationDetail } from "./application-review";
import { candidateOf, CandidateFields, Confirm, ErrorLine, GateBadge, GateErrors, message, Page, type CandidateDraft } from "./shared";

// THE ONBOARDING QUEUE. A self sign-up becomes an application, never a business; approving it
// re-runs the green-gate NOW and provisions the business and invites its owner — the SUPER_ADMIN's
// alone. A programme officer reviews, rejects and prepares batches. Batch CSV onboarding: download the
// template, upload, correct or remove red rows, and commit — only when EVERY row is green.

const OPEN_STATUSES: readonly ApplicationStatus[] = ["SUBMITTED", "UNDER_REVIEW", "NEEDS_CHANGES"];

function Queue({ permissions, selfId, initialStatus }: { permissions: AdminPermissions; selfId: string; initialStatus?: ApplicationStatus }) {
  const ids = { status: useId(), source: useId() };
  // "OPEN" (the default) is every application still in progress — waiting, under review or back
  // with the applicant — so one leaves the default view only when it is decided.
  const [status, setStatus] = useState<ApplicationStatus | "" | "OPEN">(initialStatus ?? "OPEN");
  const [source, setSource] = useState<ApplicationSource | "">("");
  const query = useApplications({ status: status === "OPEN" ? "" : status, source });
  const rows = query.data?.data.filter((a) => status !== "OPEN" || OPEN_STATUSES.includes(a.status)) ?? [];
  const applications = query;
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField id={ids.status} label="Status" value={status} onChange={(v) => setStatus(v as ApplicationStatus | "" | "OPEN")}>
          <option value="OPEN">In progress</option>
          <option value="">Every application</option>
          {STAFF_STATUSES.map((s) => (
            <option key={s} value={s}>
              {APPLICATION_STATUS_LABEL[s]}
            </option>
          ))}
        </SelectField>
        <SelectField id={ids.source} label="Came from" value={source} onChange={(v) => setSource(v as ApplicationSource | "")}>
          <option value="">Anywhere</option>
          {(Object.keys(SOURCE_LABEL) as ApplicationSource[]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </SelectField>
      </div>
      {applications.isPending ? <LoadingState label="Loading applications" lines={4} /> : null}
      {applications.isError ? <ErrorState title="Couldn’t load the applications" description={applications.error.message} onRetry={() => void applications.refetch()} /> : null}
      {applications.isSuccess && rows.length === 0 ? <EmptyState title={status === "OPEN" ? "Nothing in progress" : "No applications match"} description="Self sign-ups and batch rows appear here." /> : null}
      {applications.isSuccess && rows.length > 0 ? (
        <ul aria-label="Applications" className="space-y-2">
          {rows.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setOpen(a.id)}
                className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>
                  <span className="font-medium">{a.businessName}</span>
                  <span className="block text-xs text-muted-foreground">
                    {a.ownerFullName} · {a.ownerEmail} · {SOURCE_LABEL[a.source]} · {formatDateTime(a.submittedAt)}
                  </span>
                </span>
                <span className="rounded-full border px-2 py-0.5 text-xs">{APPLICATION_STATUS_LABEL[a.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <Sheet key={open} title="Application" onClose={() => setOpen(null)} wide>
          <ApplicationDetail
            applicationId={open}
            permissions={permissions}
            viewerId={selfId}
            onDone={(note) => {
              setOpen(null);
              setNotice(note);
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}

// ---- Batch CSV onboarding ----

const draftOfRow = (row: PreviewRow): CandidateDraft => {
  const a = row.application;
  return { businessName: a.businessName, subdomain: a.proposedSubdomain ?? "", sector: a.sector ?? "", kraPin: a.kraPin ?? "", taxRegime: a.taxRegime, ownerFullName: a.ownerFullName, ownerEmail: a.ownerEmail, ownerPhone: a.ownerPhone ?? "", ownerNationalId: a.ownerNationalId ?? "" };
};

function RowEditor({ row, onDone, onCancel }: { row: PreviewRow; onDone: (note: string) => void; onCancel: () => void }) {
  const invalidate = useInvalidateAdmin();
  const [draft, setDraft] = useState<CandidateDraft>(() => draftOfRow(row));
  const [errors, setErrors] = useState(row.errors);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const next = await editRow(row.application.id, candidateOf(draft));
      await invalidate();
      if (next.status === "GREEN") onDone(`Row ${String(row.application.batchRowNumber)} is green now.`);
      else setErrors(next.errors);
    } catch (failure) {
      setError(message(failure, "The row could not be saved. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form noValidate aria-label={`Correct row ${String(row.application.batchRowNumber)}`} onSubmit={(e) => void submit(e)} className="space-y-3 rounded-md border p-3">
      <CandidateFields draft={draft} onChange={setDraft} errors={errors} />
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" className="h-11" disabled={saving}>
          {saving ? "Checking…" : "Save and re-check"}
        </Button>
      </div>
    </form>
  );
}

function PreviewRowView({ row, editable }: { row: PreviewRow; editable: boolean }) {
  const invalidate = useInvalidateAdmin();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const a = row.application;
  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await removeRow(a.id);
      await invalidate();
    } catch (failure) {
      setRemoving(false);
      setError(message(failure, "The row could not be removed. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <li aria-label={`Row ${String(a.batchRowNumber)} · ${a.businessName}`} className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            Row {String(a.batchRowNumber)} · {a.businessName}
          </p>
          <p className="text-xs text-muted-foreground">
            {a.ownerFullName} · {a.ownerEmail}
            {row.proposedSubdomain ? ` · ${row.proposedSubdomain}` : ""}
          </p>
        </div>
        <GateBadge status={row.status} />
      </div>
      <GateErrors errors={row.errors} />
      {notice ? <Done>{notice}</Done> : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {editable && editing ? (
        <RowEditor
          row={row}
          onCancel={() => setEditing(false)}
          onDone={(note) => {
            setEditing(false);
            setNotice(note);
          }}
        />
      ) : null}
      {editable && removing ? (
        <Confirm title={`Remove row ${String(a.batchRowNumber)} (${a.businessName}) from the batch?`} yes="Yes, remove it" busy={saving} destructive onBack={() => setRemoving(false)} onYes={() => void remove()}>
          <p>It will not be onboarded with the batch.</p>
        </Confirm>
      ) : null}
      {editable && !editing && !removing ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="h-11" onClick={() => setEditing(true)}>
            Correct
          </Button>
          <Button type="button" variant="outline" className="h-11" onClick={() => setRemoving(true)}>
            Remove
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function Batch({ permissions }: { permissions: AdminPermissions }) {
  const fileId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const invalidate = useInvalidateAdmin();
  const [batchId, setBatchId] = useState<string | null>(null);
  const batch = useBatch(batchId);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);

  async function download() {
    setError(null);
    try {
      const csv = await fetchTemplate();
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "onboarding-template.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (failure) {
      setError(message(failure, "The template could not be downloaded. Please try again."));
    }
  }
  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose the CSV file first.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const preview = await uploadBatch(await file.text());
      setBatchId(preview.batch.id);
      await invalidate();
    } catch (failure) {
      // The chosen file stays chosen, so it can be fixed and sent again.
      setError(message(failure, "The file could not be uploaded. Please try again."));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!batchId) return;
    setBusy(true);
    setError(null);
    try {
      const done = await commitBatch(batchId);
      await invalidate();
      setCommitting(false);
      setNotice(done.alreadyCommitted ? "This batch was already committed; nothing new was set up." : `${done.onboarded.length.toString()} businesses set up; each owner has been invited.`);
    } catch (failure) {
      setCommitting(false);
      setError(message(failure, "The batch could not be committed. Please try again."));
      await batch.refetch();
    } finally {
      setBusy(false);
    }
  }

  const preview = batch.data;
  const committed = preview?.batch.status === "COMMITTED";
  const red = preview ? preview.rows.filter((r) => r.status === "RED").length : 0;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Fill the template, one business per row, and upload it. Nothing is set up on upload: every row is checked, red rows can be corrected or removed, and the batch is committed only when every row is green.</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Button type="button" variant="outline" className="h-11" onClick={() => void download()}>
          <Download className="size-4" aria-hidden /> Download the template
        </Button>
        <div className="space-y-1">
          <label htmlFor={fileId} className="text-sm font-medium">
            CSV file
          </label>
          <input id={fileId} ref={fileRef} type="file" accept=".csv,text/csv" className="block min-h-11 text-sm" />
        </div>
        <Button type="button" className="h-11" onClick={() => void upload()} disabled={busy}>
          <Upload className="size-4" aria-hidden /> {busy && !preview ? "Checking…" : "Upload and check"}
        </Button>
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {notice ? <Done>{notice}</Done> : null}
      {batchId && batch.isPending ? <LoadingState label="Loading the batch" lines={3} /> : null}
      {preview ? (
        <section aria-label="Batch preview" className="space-y-3">
          <p className="text-sm" aria-live="polite">
            {preview.rows.length.toString()} rows · {(preview.rows.length - red).toString()} green · {red.toString()} red{committed ? " · committed" : ""}
          </p>
          <ul aria-label="Batch rows" className="space-y-2">
            {preview.rows.map((row) => (
              <PreviewRowView key={row.application.id} row={row} editable={!committed} />
            ))}
          </ul>
          {!committed && permissions.isSuperAdmin ? (
            committing ? (
              <Confirm title={`Set up all ${preview.rows.length.toString()} businesses?`} yes="Yes, commit the batch" busy={busy} onBack={() => setCommitting(false)} onYes={() => void commit()}>
                <p>Each business is created and its owner invited. Every row is checked again first; if any is red, nothing is set up.</p>
              </Confirm>
            ) : (
              <Button type="button" className="h-11" disabled={!preview.allGreen} onClick={() => setCommitting(true)}>
                Commit the batch
              </Button>
            )
          ) : null}
          {!committed && permissions.isSuperAdmin && !preview.allGreen ? <p className="text-sm text-muted-foreground">Correct or remove every red row to commit.</p> : null}
          {!committed && !permissions.isSuperAdmin ? <p className="text-sm text-muted-foreground">A super-administrator commits the batch once every row is green.</p> : null}
        </section>
      ) : null}
    </div>
  );
}

const TABS: readonly Tab[] = [
  { id: "queue", label: "Queue" },
  { id: "batch", label: "Batch upload" },
];

export function Applications({ permissions, selfId = "", initialStatus }: { permissions: AdminPermissions; selfId?: string; initialStatus?: ApplicationStatus }) {
  const [active, setActive] = useState("queue");
  return (
    <Page title="Applications" intro="Businesses asking to join, one at a time or by the batch. Nothing is set up until an application is approved.">
      <div>
        <Tabs tabs={TABS} active={active} onChange={setActive} label="Applications" />
        <TabPanel id={active}>{active === "queue" ? <Queue permissions={permissions} selfId={selfId} initialStatus={initialStatus} /> : <Batch permissions={permissions} />}</TabPanel>
      </div>
    </Page>
  );
}
