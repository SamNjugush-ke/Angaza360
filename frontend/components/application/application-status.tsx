"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FormAlert, UNAVAILABLE } from "@/components/auth/form-bits";
import { tierLabel } from "@/lib/application/application";
import { formatDateTime } from "@/lib/datetime";

// THE APPLICANT'S STATUS PAGE (M4.5 Wave 2). The link we email carries the application's access
// token in the URL FRAGMENT, which never reaches a server or a log. On load the page hands it to
// /api/application/open ONCE (which keeps it only in an HttpOnly cookie), wipes it from the
// address bar, and then reads the status through that cookie. It shows what was submitted (the
// National ID masked — the ID document itself is never shown), what to change, the decision and
// its reason, the timeline and the next step.

interface Status {
  status: "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "NEEDS_CHANGES" | "APPROVED" | "REJECTED";
  application: Record<string, string | null>;
  documents: Array<{ side: string; contentType: string; byteSize: number; uploadedAt: string; deleted: boolean }>;
  changesRequested: string | null;
  rejectionReason: string | null;
  timeline: Array<{ kind: string; message: string | null; corrections: Array<{ field: string; from: string | null; to: string | null }>; at: string }>;
  nextActions: string[];
  editable: boolean;
}

export const STATUS_HEADLINE: Readonly<Record<Status["status"], { title: string; detail: string }>> = {
  DRAFT: { title: "Not submitted yet", detail: "Your application is saved but has not been sent for review." },
  SUBMITTED: { title: "Received — waiting for review", detail: "A member of the team will start reviewing it soon. We’ll email you at each step." },
  UNDER_REVIEW: { title: "Under review", detail: "A reviewer is checking the application and the ID document." },
  NEEDS_CHANGES: { title: "Changes needed", detail: "The reviewer has asked for some changes before the application can go further." },
  APPROVED: { title: "Approved", detail: "Your account is being opened. Look out for the invitation email — it has the link to set your password." },
  REJECTED: { title: "Not approved", detail: "The application was not approved. The reason is below; you are welcome to apply again." },
};

const EVENT_LABEL: Readonly<Record<string, string>> = {
  SUBMITTED: "Submitted",
  REVIEW_STARTED: "Review started",
  CHANGES_REQUESTED: "Changes requested",
  CORRECTED: "A detail was corrected by the reviewer",
  RESUBMITTED: "Resubmitted",
  APPROVED: "Approved",
  REJECTED: "Not approved",
  DOCUMENTS_PURGED: "ID document deleted (retention schedule)",
};

const FIELD_LABEL: Readonly<Record<string, string>> = {
  businessName: "Business name",
  businessStructure: "Structure",
  registrationNumber: "Registration number",
  businessKraPin: "Business KRA PIN",
  kraPin: "Owner’s KRA PIN",
  taxRegime: "Tax regime",
  sector: "What it does",
  description: "Description",
  physicalAddress: "Address",
  county: "County",
  permitNumber: "Permit number",
  businessPhone: "Business phone",
  businessEmail: "Business email",
  requestedTier: "Plan",
  ownerFullName: "Owner",
  ownerEmail: "Owner’s email",
  ownerPhone: "Owner’s phone",
  ownerNationalIdMasked: "Owner’s National ID",
};

const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/** Moves the fragment's token (once) into the HttpOnly cookie. */
async function adoptFragmentToken(): Promise<"none" | "ok" | "invalid"> {
  const token = window.location.hash.replace(/^#/, "");
  if (token === "") return "none";
  // Wipe it from the address bar and history before anything else.
  window.history.replaceState(null, "", window.location.pathname);
  const response = await fetch("/api/application/open", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => null);
  return response?.status === 204 ? "ok" : "invalid";
}

export function ApplicationStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const adopted = await adoptFragmentToken();
      if (adopted === "invalid") {
        setProblem("This link has expired or is not complete. Use the link in our most recent email.");
        return;
      }
      const response = await fetch("/api/application", { credentials: "same-origin" }).catch(() => null);
      if (response === null || response.status >= 500) setProblem(UNAVAILABLE);
      else if (!response.ok) setProblem("No application is open in this browser. Use the link in our most recent email, or start a new application.");
      else setStatus((await response.json()) as Status);
    })();
  }, []);

  if (problem) {
    return (
      <div className="space-y-4">
        <FormAlert id="status-problem">{problem}</FormAlert>
        <Link href="/signup" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Start a new application
        </Link>
      </div>
    );
  }
  if (!status) return <p role="status">Opening your application…</p>;

  const headline = STATUS_HEADLINE[status.status];
  const facts = Object.entries(status.application).filter(([, value]) => value !== null && value !== "");
  return (
    <div className="space-y-6">
      <section aria-labelledby="status-title" className="space-y-1 rounded-lg border bg-card p-4">
        <h2 id="status-title" className="font-display text-lg font-semibold">
          {headline.title}
        </h2>
        <p className="text-sm text-muted-foreground">{headline.detail}</p>
      </section>

      {status.changesRequested ? (
        <section aria-labelledby="changes-title" className="space-y-1 rounded-lg border border-warning/40 p-4">
          <h2 id="changes-title" className="font-semibold">
            What the reviewer asked for
          </h2>
          <p className="whitespace-pre-line text-sm">{status.changesRequested}</p>
        </section>
      ) : null}
      {status.rejectionReason ? (
        <section aria-labelledby="reason-title" className="space-y-1 rounded-lg border p-4">
          <h2 id="reason-title" className="font-semibold">
            The reason
          </h2>
          <p className="whitespace-pre-line text-sm">{status.rejectionReason}</p>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {status.editable ? (
          <Link href="/application/edit" className={buttonClass}>
            {status.status === "DRAFT" ? "Finish the application" : "Make the changes"}
          </Link>
        ) : null}
        {status.nextActions.includes("APPLY_AGAIN") ? (
          <Link href="/signup" className={buttonClass}>
            Apply again
          </Link>
        ) : null}
        {status.nextActions.includes("SIGN_IN_FROM_INVITATION") ? (
          <Link href="/login" className={buttonClass}>
            Go to sign in
          </Link>
        ) : null}
      </div>

      <section aria-labelledby="submitted-title" className="space-y-2">
        <h2 id="submitted-title" className="font-semibold">
          What you submitted
        </h2>
        <dl className="divide-y rounded-md border text-sm">
          {facts.map(([field, value]) => (
            <div key={field} className="flex justify-between gap-4 px-3 py-2">
              <dt className="text-muted-foreground">{FIELD_LABEL[field] ?? field}</dt>
              <dd className="break-all text-right">{field === "requestedTier" && value !== null ? tierLabel(value) : value}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-4 px-3 py-2">
            <dt className="text-muted-foreground">ID document</dt>
            <dd className="text-right">
              {status.documents.length === 0
                ? "Not uploaded"
                : status.documents.every((doc) => doc.deleted)
                  ? "Deleted on the retention schedule"
                  : `${status.documents.filter((doc) => !doc.deleted).length} side(s) uploaded`}
            </dd>
          </div>
        </dl>
      </section>

      {status.timeline.length > 0 ? (
        <section aria-labelledby="timeline-title" className="space-y-2">
          <h2 id="timeline-title" className="font-semibold">
            What has happened
          </h2>
          <ol className="space-y-3 border-l pl-4 text-sm">
            {status.timeline.map((event, index) => (
              <li key={`${event.kind}-${index.toString()}`}>
                <p className="font-medium">{EVENT_LABEL[event.kind] ?? event.kind}</p>
                <p className="text-muted-foreground">{formatDateTime(event.at)}</p>
                {event.message ? <p className="whitespace-pre-line">{event.message}</p> : null}
                {event.corrections.length > 0 ? (
                  <ul className="mt-1 list-disc pl-5">
                    {event.corrections.map((c) => (
                      <li key={c.field}>
                        {FIELD_LABEL[c.field] ?? c.field} changed from “{c.from ?? "blank"}” to “{c.to ?? "blank"}”
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
