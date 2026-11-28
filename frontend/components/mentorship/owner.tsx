"use client";

import { useId, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import {
  completeMyItem,
  consent,
  CONSENT_LABEL,
  decline,
  endEngagement,
  ENGAGEMENT_STATUS_LABEL,
  GOAL_STATUS_LABEL,
  ITEM_STATUS_LABEL,
  PARTY_LABEL,
  setMembershipConsent,
  SOURCE_LABEL,
  useInvalidateMentorship,
  useMembershipLog,
  useMemberships,
  useMyEngagement,
  useMyEngagements,
  type ActionItem,
  type Engagement,
  type MembershipEntry,
  type OwnerView,
  type SourceKey,
} from "@/lib/mentorship/mentorship";
import { EngagementBadge } from "./mentor";

// THE OWNER'S SIDE OF MENTORING — transparency by default. A mentor sees nothing of this business
// until the owner CONSENTS; every read of its figures is logged and listed here; the owner can end an
// engagement at any time, which stops all further reads. The same holds for a donor programme: the
// business's figures enter the programme's cohort totals only while the owner's consent stands.

const message = (failure: unknown, fallback: string) => (failure instanceof ApiHttpError ? failure.message : fallback);

/** What a logged read was, in words. */
export function resourceLabel(resource: string): string {
  if (resource === "snapshot") return "This month’s figures (revenue, profit, cash)";
  if (resource === "cohort") return "Headline figures for the mentor’s cohort";
  if (resource === "aggregate") return "The programme’s cohort totals";
  const [kind, keys] = resource.split(":");
  const named = (keys ?? "")
    .split(",")
    .filter(Boolean)
    .map((k) => SOURCE_LABEL[k as SourceKey] ?? k)
    .join(", ");
  if (kind === "dashboard") return `The engagement dashboard (${named})`;
  if (kind === "indicator") return `A KPI: ${named}`;
  return resource;
}

function ErrorLine({ children }: { children: string }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

// ---- An invitation: consent or decline ----

function Invitation({ engagement, onDone }: { engagement: Engagement; onDone: (note: string) => void }) {
  const heading = useId();
  const invalidate = useInvalidateMentorship();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function answer(yes: boolean) {
    setSaving(true);
    setError(null);
    try {
      await (yes ? consent(engagement.id) : decline(engagement.id));
      await invalidate();
      onDone(yes ? `${engagement.mentorName} can now mentor ${engagement.businessName}. Every read of your figures appears in the access log.` : `You declined ${engagement.mentorName}’s invitation. Nothing was shared.`);
    } catch (failure) {
      setError(message(failure, "Your answer could not be saved. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section aria-labelledby={heading} className="space-y-3 rounded-lg border border-amber-600/40 bg-amber-500/10 p-4 text-sm">
      <h2 id={heading} className="font-medium">
        {engagement.mentorName} ({engagement.mentorRole === "COACH" ? "coach" : "mentor"}) has been invited to mentor your business
      </h2>
      <p>If you consent, they will be able to read — from your own books, never change:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>this month’s revenue, gross and net profit and cash position;</li>
        <li>the KPIs you agree with them, computed live from your books.</li>
      </ul>
      <p>
        <strong>Every read is recorded</strong> with who read what and when, and you can see that log here. You can end the engagement at any time; after that nothing more can be read.
      </p>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" disabled={saving} onClick={() => void answer(false)}>
          Decline
        </Button>
        <Button type="button" className="h-11" disabled={saving} onClick={() => void answer(true)}>
          {saving ? "Saving…" : "I consent"}
        </Button>
      </div>
    </section>
  );
}

// ---- One engagement, in full ----

function AccessLog({ entries }: { entries: OwnerView["accessLog"] }) {
  return (
    <section aria-label="Access log" className="space-y-2">
      <h3 className="font-medium">Who read your figures</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has been read yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[28rem] text-sm">
            <caption className="sr-only">Every read of your business’s figures under this engagement, newest first</caption>
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th scope="col" className="p-2 font-medium">
                  When
                </th>
                <th scope="col" className="p-2 font-medium">
                  Who
                </th>
                <th scope="col" className="p-2 font-medium">
                  What
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b last:border-b-0">
                  <td className="p-2 tabular-nums">{formatDateTime(entry.viewedAt)}</td>
                  <th scope="row" className="p-2 text-left font-normal">
                    {entry.mentorName}
                  </th>
                  <td className="p-2">{resourceLabel(entry.resource)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MyItem({ item, active }: { item: ActionItem; active: boolean }) {
  const invalidate = useInvalidateMentorship();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mine = item.responsibleParty === "ENTREPRENEUR";
  async function done() {
    setSaving(true);
    setError(null);
    try {
      await completeMyItem(item.id);
      await invalidate();
    } catch (failure) {
      setError(message(failure, "It could not be marked done. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <li aria-label={item.title} className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{item.title}</p>
          <p className="text-xs text-muted-foreground">
            {mine ? "Yours" : PARTY_LABEL[item.responsibleParty]}
            {item.dueDate ? ` · due ${formatDate(item.dueDate)}` : ""}
          </p>
        </div>
        <span className="rounded-full border px-2 py-0.5 text-xs">{ITEM_STATUS_LABEL[item.status]}</span>
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {active && mine && item.status === "OPEN" ? (
        <Button type="button" variant="outline" className="h-11" disabled={saving} onClick={() => void done()} aria-label={`Mark “${item.title}” done`}>
          Mark done
        </Button>
      ) : null}
    </li>
  );
}

function EndMine({ engagement, onEnded }: { engagement: Engagement; onEnded: (note: string) => void }) {
  const title = useId();
  const invalidate = useInvalidateMentorship();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      await endEngagement(engagement.id);
      await invalidate();
      onEnded(`The engagement with ${engagement.mentorName} has ended. They can no longer read your figures.`);
    } catch (failure) {
      setError(message(failure, "The engagement could not be ended. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  if (!asking)
    return (
      <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(true)}>
        End this engagement
      </Button>
    );
  return (
    <div role="alertdialog" aria-labelledby={title} className="space-y-2 rounded-md border p-3 text-sm">
      <p id={title} className="font-medium">
        End the engagement with {engagement.mentorName}?
      </p>
      <p>They lose access to your figures at once. What you agreed stays here as history.</p>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving} data-autofocus>
          Back
        </Button>
        <Button type="button" variant="destructive" className="h-11" onClick={() => void confirm()} disabled={saving}>
          {saving ? "Ending…" : "Yes, end it"}
        </Button>
      </div>
    </div>
  );
}

function MyEngagementDetail({ engagementId, onDone }: { engagementId: string; onDone: (note: string) => void }) {
  const view = useMyEngagement(engagementId);
  if (view.isPending) return <LoadingState label="Loading the engagement" lines={5} />;
  if (view.isError) return <ErrorState title="Couldn’t load the engagement" description={view.error.message} onRetry={() => void view.refetch()} />;
  const v = view.data;
  const e = v.engagement;
  const active = e.status === "ACTIVE";
  return (
    <div className="space-y-5">
      <div className="space-y-1 text-sm">
        <EngagementBadge status={e.status} />
        <p className="text-muted-foreground">
          {e.mentorName} · {e.consentGivenAt ? `you consented ${formatDate(e.consentGivenAt)}` : "not consented"}
          {e.endedAt ? ` · ended ${formatDate(e.endedAt)}${e.endedReason ? ` (${e.endedReason})` : ""}` : ""}
        </p>
      </div>
      {e.status === "INVITED" ? <Invitation engagement={e} onDone={onDone} /> : null}
      <AccessLog entries={v.accessLog} />
      <section aria-label="Goals" className="space-y-2">
        <h3 className="font-medium">Goals</h3>
        {v.goals.length === 0 ? <p className="text-sm text-muted-foreground">None agreed yet.</p> : null}
        <ul className="space-y-1 text-sm">
          {v.goals.map((g) => (
            <li key={g.id} className="flex justify-between gap-3 border-b py-1.5">
              <span>
                {g.title}
                {g.targetValue ? <span className="text-muted-foreground"> · target KES {formatKES(g.targetValue)}</span> : null}
              </span>
              <span className="text-muted-foreground">{GOAL_STATUS_LABEL[g.status]}</span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Agreed KPIs" className="space-y-2">
        <h3 className="font-medium">KPIs agreed</h3>
        {v.indicators.length === 0 ? <p className="text-sm text-muted-foreground">None agreed yet.</p> : null}
        <ul className="space-y-1 text-sm">
          {v.indicators.map((i) => (
            <li key={i.id} className="flex justify-between gap-3 border-b py-1.5">
              <span>{i.name}</span>
              <span className="text-muted-foreground">Target {i.kind === "AMOUNT" ? `KES ${formatKES(i.targetAmount ?? "0")}` : `${i.targetRate ?? ""}${i.sourceKey === "INVENTORY_TURNOVER" ? "×" : "%"}`}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">Your own reports show how your business stands against these.</p>
      </section>
      <section aria-label="Action plan" className="space-y-2">
        <h3 className="font-medium">Action plan</h3>
        {v.actionItems.open.length + v.actionItems.closed.length === 0 ? <p className="text-sm text-muted-foreground">No action items yet.</p> : null}
        <ul className="space-y-2">
          {[...v.actionItems.open, ...v.actionItems.closed].map((item) => (
            <MyItem key={item.id} item={item} active={active} />
          ))}
        </ul>
      </section>
      <section aria-label="Coaching sessions" className="space-y-2">
        <h3 className="font-medium">Coaching sessions</h3>
        {v.sessions.length === 0 ? <p className="text-sm text-muted-foreground">None recorded yet.</p> : null}
        <ul className="space-y-2 text-sm">
          {v.sessions.map((s) => (
            <li key={s.id} className="rounded-lg border p-3">
              <p className="font-medium">{formatDate(s.sessionDate)}</p>
              <p>{s.summary}</p>
              {s.commitments ? <p className="text-muted-foreground">Commitments: {s.commitments}</p> : null}
            </li>
          ))}
        </ul>
      </section>
      {active ? <EndMine engagement={e} onEnded={onDone} /> : null}
    </div>
  );
}

function MentoringView() {
  const engagements = useMyEngagements();
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const done = (note: string) => {
    setOpen(null);
    setNotice(note);
  };
  const all = engagements.data?.data ?? [];
  const invited = all.filter((e) => e.status === "INVITED");
  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      {engagements.isPending ? <LoadingState label="Loading mentoring" lines={3} /> : null}
      {engagements.isError ? <ErrorState title="Couldn’t load the mentoring on your business" description={engagements.error.message} onRetry={() => void engagements.refetch()} /> : null}
      {engagements.isSuccess && all.length === 0 ? <EmptyState title="No mentoring yet" description="When a programme invites a mentor to your business, you will be asked to consent here." /> : null}
      {invited.map((e) => (
        <Invitation key={e.id} engagement={e} onDone={setNotice} />
      ))}
      {all.length > 0 ? (
        <ul aria-label="Mentoring on your business" className="space-y-2">
          {all.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => setOpen(e.id)}
                aria-label={`${e.mentorName} · ${ENGAGEMENT_STATUS_LABEL[e.status]}`}
                className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>
                  <span className="font-medium">{e.mentorName}</span>
                  <span className="block text-xs text-muted-foreground">{e.startedAt ? `Since ${formatDate(e.startedAt)}` : `Invited ${formatDate(e.createdAt)}`} · goals, action plan, sessions and access log</span>
                </span>
                <EngagementBadge status={e.status} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <Sheet key={open} title="Mentoring engagement" onClose={() => setOpen(null)} wide>
          <MyEngagementDetail engagementId={open} onDone={done} />
        </Sheet>
      ) : null}
    </div>
  );
}

// ---- Donor programmes ----

function MembershipLog({ membershipId }: { membershipId: string }) {
  const log = useMembershipLog(membershipId);
  if (log.isPending) return <LoadingState label="Loading the access log" lines={2} />;
  if (log.isError) return <ErrorState title="Couldn’t load the access log" description={log.error.message} onRetry={() => void log.refetch()} />;
  if (log.data.data.length === 0) return <p className="text-sm text-muted-foreground">The programme has not read your figures.</p>;
  return (
    <ul aria-label="Programme access log" className="space-y-1 text-sm">
      {log.data.data.map((entry) => (
        <li key={entry.id} className="flex flex-wrap justify-between gap-2 border-b py-1.5">
          <span>{resourceLabel(entry.resource)}</span>
          <span className="tabular-nums text-muted-foreground">{formatDateTime(entry.viewedAt)} · by {entry.readerName ?? "programme staff"}</span>
        </li>
      ))}
    </ul>
  );
}

function Membership({ entry }: { entry: MembershipEntry }) {
  const heading = useId();
  const invalidate = useInvalidateMentorship();
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { membership: m, project: p } = entry;
  const consented = m.consentStatus === "CONSENTED";
  const closed = p.status === "CLOSED";
  async function change(action: "consent" | "withdraw") {
    setSaving(true);
    setError(null);
    try {
      await setMembershipConsent(m.id, action);
      await invalidate();
      setNotice(action === "consent" ? `Your figures now count in ${p.name}’s cohort totals.` : `Consent withdrawn: ${p.name} no longer reads your figures.`);
    } catch (failure) {
      setError(message(failure, "Your choice could not be saved. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section aria-labelledby={heading} className="space-y-3 rounded-lg border p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={heading} className="font-medium">
            {p.name}
          </h2>
          <p className="text-xs text-muted-foreground">
            {p.donor} · {p.code}
            {closed ? " · closed" : ""}
          </p>
        </div>
        <span className="rounded-full border px-2 py-0.5 text-xs">{CONSENT_LABEL[m.consentStatus]}</span>
      </div>
      <p>
        {consented
          ? "Your business’s revenue and profit are included in this programme’s cohort totals. Each read is logged below. You can withdraw at any time."
          : "Your business is a member, but its figures are NOT read and not counted in the programme’s totals unless you consent. Only totals across consenting businesses are reported to the donor; programme staff can see each consenting business’s own figures."}
      </p>
      {notice ? <Done>{notice}</Done> : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {!closed ? (
        consented ? (
          <Button type="button" variant="outline" className="h-11" disabled={saving} onClick={() => void change("withdraw")}>
            Withdraw consent
          </Button>
        ) : (
          <Button type="button" className="h-11" disabled={saving} onClick={() => void change("consent")}>
            I consent
          </Button>
        )
      ) : null}
      <div>
        <Button type="button" variant="ghost" className="h-11 px-0 underline underline-offset-4" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
          {showLog ? "Hide the access log" : "Show the access log"}
        </Button>
        {showLog ? <MembershipLog membershipId={m.id} /> : null}
      </div>
    </section>
  );
}

function ProgrammesView() {
  const memberships = useMemberships();
  if (memberships.isPending) return <LoadingState label="Loading programmes" lines={3} />;
  if (memberships.isError) return <ErrorState title="Couldn’t load your programmes" description={memberships.error.message} onRetry={() => void memberships.refetch()} />;
  if (memberships.data.data.length === 0) return <EmptyState title="No programmes" description="When a donor programme enrols your business, you will be asked to consent here." />;
  return (
    <div className="space-y-3">
      {memberships.data.data.map((entry) => (
        <Membership key={entry.membership.id} entry={entry} />
      ))}
    </div>
  );
}

const TABS: readonly Tab[] = [
  { id: "mentoring", label: "Mentoring" },
  { id: "programmes", label: "Programmes" },
];

/** /mentorship for the business owner. */
export function OwnerMentorship() {
  const [active, setActive] = useState("mentoring");
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl font-semibold">Mentorship</h1>
        <p className="text-sm text-muted-foreground">Mentors and programmes see your figures only with your consent, every read is logged here, and you can stop it at any time.</p>
      </div>
      <div>
        <Tabs tabs={TABS} active={active} onChange={setActive} label="Mentorship" />
        <TabPanel id={active}>{active === "mentoring" ? <MentoringView /> : <ProgrammesView />}</TabPanel>
      </div>
    </div>
  );
}
