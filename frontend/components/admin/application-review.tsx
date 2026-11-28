"use client";

import { useId, useState } from "react";
import { TextField } from "@/components/auth/form-bits";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/datetime";
import {
  APPLICATION_STATUS_LABEL,
  approveApplication,
  correctApplication,
  documentViewGrant,
  documentViewUrl,
  REGIME_LABEL,
  rejectApplication,
  requestChanges,
  SOURCE_LABEL,
  startReview,
  STRUCTURE_LABEL,
  TIMELINE_LABEL,
  useApplication,
  useInvalidateAdmin,
  type AdminPermissions,
  type Correction,
  type DocumentMeta,
} from "@/lib/admin/admin";
import { Confirm, ErrorLine, GateBadge, GateErrors, message } from "./shared";

// ONE APPLICATION UNDER REVIEW (M4.5 W2). The steps follow the server's state machine:
// SUBMITTED → Start review (you become its reviewing officer); UNDER_REVIEW → Request changes,
// Correct an administrative detail, Approve (a SUPER_ADMIN) or Reject. Identity and ownership
// are the applicant's to change — this screen offers no way to edit them. The owner's ID document
// is opened only through a single-use, two-minute grant, in a new tab, and every view is audited;
// it is never kept here.

const MINOR: ReadonlyArray<{ key: keyof Correction; label: string }> = [
  { key: "sector", label: "Sector" },
  { key: "description", label: "Description" },
  { key: "physicalAddress", label: "Physical address" },
  { key: "county", label: "County" },
  { key: "permitNumber", label: "Business permit number" },
  { key: "businessPhone", label: "Business phone" },
  { key: "businessEmail", label: "Business email" },
];

function DocumentRow({ applicationId, document, canView }: { applicationId: string; document: DocumentMeta; canView: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deleted = document.purgedAt !== null;
  async function open() {
    setBusy(true);
    setError(null);
    // Open the tab synchronously (a pop-up blocker allows it), then point it at the one-time link.
    const tab = window.open("about:blank", "_blank", "noopener=no");
    try {
      const grant = await documentViewGrant(applicationId, document.id);
      if (tab) tab.location.href = documentViewUrl(grant.token);
      else window.location.assign(documentViewUrl(grant.token));
    } catch (failure) {
      tab?.close();
      setError(message(failure, "The document could not be opened."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm last:border-b-0">
      <span>
        ID document — {document.side === "FRONT" ? "front" : "back"}
        <span className="block text-xs text-muted-foreground">
          {deleted ? `Deleted under the retention schedule ${formatDateTime(document.purgedAt ?? "")}` : `${document.contentType} · ${Math.round(document.byteSize / 1024).toString()} KB · ${formatDateTime(document.uploadedAt)}`}
        </span>
      </span>
      {canView && !deleted ? (
        <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={() => void open()}>
          {busy ? "Opening…" : "View (logged)"}
        </Button>
      ) : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </li>
  );
}

export function ApplicationDetail({
  applicationId,
  permissions,
  viewerId,
  onDone,
}: {
  applicationId: string;
  permissions: AdminPermissions;
  viewerId: string;
  onDone: (note: string) => void;
}) {
  const ids = { reason: useId(), message: useId() };
  const invalidate = useInvalidateAdmin();
  const review = useApplication(applicationId);
  const [asking, setAsking] = useState<"approve" | "reject" | "changes" | "correct" | null>(null);
  const [text, setText] = useState("");
  const [correction, setCorrection] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (review.isPending) return <LoadingState label="Loading the application" lines={5} />;
  if (review.isError) return <ErrorState title="Couldn’t load the application" description={review.error.message} onRetry={() => void review.refetch()} />;
  const { application: a, validation, documents, timeline } = review.data;
  const batchRow = a.source === "BATCH";
  const canViewDocuments = permissions.isSuperAdmin || a.reviewerUserId === viewerId;

  async function run(action: () => Promise<string>) {
    setSaving(true);
    setError(null);
    try {
      const note = await action();
      await invalidate();
      setAsking(null);
      setText("");
      onDone(note);
    } catch (failure) {
      setAsking(null);
      setError(message(failure, "That could not be done. Please try again."));
      await review.refetch();
    } finally {
      setSaving(false);
    }
  }

  const facts: Array<[string, string | null]> = [
    ["Status", APPLICATION_STATUS_LABEL[a.status]],
    ["Came from", `${SOURCE_LABEL[a.source]}${a.batchRowNumber !== null ? ` (row ${a.batchRowNumber.toString()})` : ""}`],
    ["Submitted", formatDateTime(a.submittedAt)],
    ["Business", a.businessName],
    ["Structure", a.businessStructure ? (STRUCTURE_LABEL[a.businessStructure] ?? a.businessStructure) : null],
    ["Registration number", a.registrationNumber],
    ["Business KRA PIN", a.businessKraPin],
    ["Owner’s KRA PIN", a.kraPin],
    ["Tax regime", REGIME_LABEL[a.taxRegime] ?? a.taxRegime],
    ["Sector", a.sector],
    ["Description", a.description],
    ["Physical address", a.physicalAddress],
    ["County", a.county],
    ["Permit number", a.permitNumber],
    ["Business phone", a.businessPhone],
    ["Business email", a.businessEmail],
    ["Subdomain", a.proposedSubdomain],
    ["Owner", a.ownerFullName],
    ["Owner’s email", a.ownerEmail],
    ["Owner’s phone", a.ownerPhone],
    ["Owner’s National ID", a.ownerNationalId],
    ["Changes asked for", a.status === "NEEDS_CHANGES" ? a.changesRequested : null],
    ["Rejected because", a.rejectionReason],
  ];

  return (
    <div className="space-y-4">
      <dl className="text-sm">
        {facts
          .filter(([, v]) => v !== null)
          .map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-all text-right">{v}</dd>
            </div>
          ))}
      </dl>

      {documents.length > 0 ? (
        <section aria-label="ID document" className="rounded-md border p-3">
          <h3 className="font-medium">Owner’s ID document</h3>
          <p className="text-sm text-muted-foreground">
            {canViewDocuments
              ? "Opens once in a new tab; every view is recorded."
              : "Only a super-administrator or the officer reviewing this application may view it."}
          </p>
          <ul>
            {documents.map((doc) => (
              <DocumentRow key={doc.id} applicationId={a.id} document={doc} canView={canViewDocuments} />
            ))}
          </ul>
        </section>
      ) : null}

      {validation ? (
        <section aria-label="Green-gate" className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">The green-gate, as things stand now</h3>
            <GateBadge status={validation.status} />
          </div>
          <GateErrors errors={validation.errors} />
        </section>
      ) : null}

      {timeline.length > 0 ? (
        <section aria-label="Timeline" className="rounded-md border p-3">
          <h3 className="font-medium">Timeline</h3>
          <ol className="mt-2 space-y-1 text-sm">
            {timeline.map((event, index) => (
              <li key={`${event.kind}-${index.toString()}`}>
                <span className="font-medium">{TIMELINE_LABEL[event.kind] ?? event.kind}</span> · {formatDateTime(event.occurredAt)}
                {event.message ? <span className="block text-muted-foreground">{event.message}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {batchRow ? <p className="text-sm text-muted-foreground">A batch row is decided with its batch, on the Batch upload tab.</p> : null}

      {!batchRow && a.status === "SUBMITTED" ? (
        <Button type="button" className="h-11" disabled={saving} onClick={() => void run(async () => { await startReview(a.id); return `You are reviewing ${a.businessName}. The applicant has been told.`; })}>
          {saving ? "Starting…" : "Start review"}
        </Button>
      ) : null}

      {!batchRow && a.status === "UNDER_REVIEW" ? (
        asking === "approve" ? (
          <Confirm title={`Approve ${a.businessName}?`} yes="Yes, approve and set it up" busy={saving} onBack={() => setAsking(null)}
            onYes={() => void run(async () => { const done = await approveApplication(a.id); return `${done.onboarded.tenant.name} is live at ${done.onboarded.tenant.subdomain}. Its owner (${done.onboarded.ownerInvitation.invitation.email}) has been invited.`; })}>
            <p>The business is created and its owner is invited. The green-gate is checked again first; if anything now clashes, nothing is set up.</p>
          </Confirm>
        ) : asking === "reject" || asking === "changes" ? (
          <Confirm
            title={asking === "reject" ? `Reject ${a.businessName}’s application?` : "Ask the applicant for changes"}
            yes={asking === "reject" ? "Yes, reject it" : "Send the request"}
            busy={saving}
            destructive={asking === "reject"}
            onBack={() => setAsking(null)}
            onYes={() => {
              if (text.trim().length < (asking === "reject" ? 1 : 5)) {
                setProblem(asking === "reject" ? "Give the reason — the applicant is told it." : "Say what needs to change (at least 5 characters).");
                return;
              }
              setProblem(null);
              void run(async () => {
                if (asking === "reject") {
                  await rejectApplication(a.id, text.trim());
                  return `${a.businessName}’s application is rejected; the applicant has been told why.`;
                }
                await requestChanges(a.id, text.trim());
                return `The request has been sent to ${a.ownerFullName}.`;
              });
            }}
          >
            <TextField
              id={asking === "reject" ? ids.reason : ids.message}
              label={asking === "reject" ? "Reason (sent to the applicant)" : "What should change (sent to the applicant)"}
              autoComplete="off"
              value={text}
              error={problem ?? undefined}
              onChange={(e) => setText(e.target.value)}
            />
          </Confirm>
        ) : asking === "correct" ? (
          <form
            className="space-y-3 rounded-md border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              const body: Record<string, string | null> = {};
              for (const field of MINOR) {
                const value = correction[field.key];
                if (value !== undefined && value.trim() !== (a[field.key as keyof typeof a] ?? "")) body[field.key] = value.trim() === "" ? null : value.trim();
              }
              if (Object.keys(body).length === 0) {
                setProblem("Change at least one detail.");
                return;
              }
              setProblem(null);
              void run(async () => {
                await correctApplication(a.id, { ...body, note: text.trim() === "" ? null : text.trim() } as Correction);
                return "The correction is saved and shown to the applicant on their timeline.";
              });
            }}
          >
            <h3 className="font-medium">Correct an administrative detail</h3>
            <p className="text-sm text-muted-foreground">
              Every change is shown to the applicant. Identity and ownership — the business name, structure, registration, KRA PINs, tax regime and
              anything about the owner — are not editable here: ask the applicant for changes instead.
            </p>
            {MINOR.map((field) => (
              <TextField
                key={field.key}
                id={`${ids.message}-${field.key}`}
                label={field.label}
                autoComplete="off"
                value={correction[field.key] ?? (a[field.key as keyof typeof a] as string | null) ?? ""}
                onChange={(e) => setCorrection((now) => ({ ...now, [field.key]: e.target.value }))}
              />
            ))}
            <TextField id={`${ids.message}-note`} label="Why (shown to the applicant)" autoComplete="off" optional value={text} onChange={(e) => setText(e.target.value)} />
            {problem ? <ErrorLine>{problem}</ErrorLine> : null}
            <div className="flex gap-2">
              <Button type="submit" className="h-11" disabled={saving}>
                {saving ? "Saving…" : "Save correction"}
              </Button>
              <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(null)}>
                Back
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            {permissions.isSuperAdmin ? (
              <Button type="button" className="h-11" onClick={() => setAsking("approve")} disabled={validation?.status === "RED"}>
                Approve
              </Button>
            ) : null}
            <Button type="button" variant="outline" className="h-11" onClick={() => { setText(""); setAsking("changes"); }}>
              Request changes
            </Button>
            <Button type="button" variant="outline" className="h-11" onClick={() => { setText(""); setCorrection({}); setAsking("correct"); }}>
              Correct a detail
            </Button>
            <Button type="button" variant="outline" className="h-11" onClick={() => { setText(""); setAsking("reject"); }}>
              Reject
            </Button>
          </div>
        )
      ) : null}
      {!batchRow && a.status === "UNDER_REVIEW" && !permissions.isSuperAdmin ? (
        <p className="text-sm text-muted-foreground">Approving sets up a business and grants its owner a role, so it is a super-administrator’s decision.</p>
      ) : null}
      {a.status === "NEEDS_CHANGES" ? <p className="text-sm text-muted-foreground">Waiting for the applicant to make the changes and resubmit.</p> : null}
    </div>
  );
}
