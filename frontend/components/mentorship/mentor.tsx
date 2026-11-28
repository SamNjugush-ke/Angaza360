"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField, TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, formatDate, formatDateTime } from "@/lib/datetime";
import { centsToAmount, formatKES, parseMajorToCents } from "@/lib/money";
import {
  createActionItem,
  createGoal,
  createIndicator,
  createSession,
  endEngagement,
  ENGAGEMENT_STATUS_LABEL,
  GOAL_FINAL,
  GOAL_STATUS_LABEL,
  GOAL_STATUSES,
  ITEM_STATUS_LABEL,
  MONEY_SOURCES,
  NEGATIVE_OK,
  PARTY_LABEL,
  RATE,
  SOURCE_LABEL,
  SOURCES,
  STANDING_LABEL,
  updateActionItem,
  updateGoal,
  useActual,
  useAcrossEngagements,
  useCohort,
  useDashboard,
  useEngagements,
  useInvalidateMentorship,
  useSession,
  useSnapshot,
  type ActionItem,
  type ActionParty,
  type Dashboard,
  type DashboardIndicator,
  type Engagement,
  type GoalStatus,
  type Session,
  type SourceKey,
} from "@/lib/mentorship/mentorship";
import { cn } from "@/lib/utils";
import { Greeting } from "@/components/shell/greeting";

// THE MENTOR / COACH WORKSPACE. A mentor sees a business's figures only through an ACTIVE
// engagement its owner consented to, and every read is logged where the owner can see it — so this
// screen fetches a business's figures only when the mentor opens them, never in the background. Until
// the owner consents the engagement shows no figures at all; once it ends, nothing more is read.

const message = (failure: unknown, fallback: string) => (failure instanceof ApiHttpError ? failure.message : fallback);
const kes = (cents: string) => `KES ${formatKES(cents)}`;

export function EngagementBadge({ status }: { status: Engagement["status"] }) {
  return (
    <span className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-medium", status === "ACTIVE" ? "border-emerald-700/40 bg-emerald-700/10" : status === "INVITED" ? "border-amber-600/40 bg-amber-500/10" : "")}>
      {ENGAGEMENT_STATUS_LABEL[status]}
    </span>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

function FormButtons({ saving, label, busy, onCancel }: { saving: boolean; label: string; busy: string; onCancel: () => void }) {
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row">
      <Button type="button" variant="outline" className="h-11" onClick={onCancel} disabled={saving}>
        Cancel
      </Button>
      <Button type="submit" className="h-11" disabled={saving}>
        {saving ? busy : label}
      </Button>
    </div>
  );
}

// ---- The snapshot (a logged read) ----

function SnapshotView({ engagementId }: { engagementId: string }) {
  const snapshot = useSnapshot(engagementId);
  if (snapshot.isPending) return <LoadingState label="Reading the business’s figures" lines={2} />;
  if (snapshot.isError) return <ErrorState title="Couldn’t read the business’s figures" description={snapshot.error.message} onRetry={() => void snapshot.refetch()} />;
  const s = snapshot.data;
  const figures: Array<[string, string]> = [
    ["Revenue", s.revenue],
    ["Gross profit", s.grossProfit],
    ["Net profit", s.netProfit],
    ["Cash position", s.cashPosition],
  ];
  return (
    <section aria-label="Month-to-date snapshot" className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {s.businessName}, {formatDate(s.period.from)} – {formatDate(s.period.to)}. This read is recorded in the owner’s access log.
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {figures.map(([label, value]) => (
          <div key={label} className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-semibold tabular-nums">{kes(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ---- Goals ----

function GoalForm({ engagementId, onDone, onCancel }: { engagementId: string; onDone: (note: string) => void; onCancel: () => void }) {
  const ids = { title: useId(), description: useId(), value: useId(), metric: useId(), date: useId() };
  const invalidate = useInvalidateMentorship();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [metric, setMetric] = useState("");
  const [date, setDate] = useState("");
  const [problems, setProblems] = useState<{ title?: string; value?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: typeof problems = {};
    if (title.trim() === "") next.title = "Name the goal.";
    if (value.trim() !== "") {
      try {
        parseMajorToCents(value);
      } catch {
        next.value = "Enter an amount in shillings, e.g. 150,000.";
      }
    }
    setProblems(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      await createGoal(engagementId, {
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(value.trim() ? { targetValue: centsToAmount(parseMajorToCents(value)) } : {}),
        ...(metric.trim() ? { targetMetric: metric.trim() } : {}),
        ...(date ? { targetDate: date } : {}),
      });
      await invalidate();
      onDone(`Goal “${title.trim()}” agreed.`);
    } catch (failure) {
      setError(message(failure, "The goal could not be saved. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form noValidate aria-label="New goal" onSubmit={(e) => void submit(e)} className="space-y-3 rounded-lg border p-3">
      <TextField id={ids.title} label="Goal" autoComplete="off" value={title} error={problems.title} onChange={(e) => setTitle(e.target.value)} />
      <TextField id={ids.description} label="Details" optional autoComplete="off" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField id={ids.value} label="Target amount (KES)" optional inputMode="decimal" autoComplete="off" value={value} error={problems.value} onChange={(e) => setValue(e.target.value)} />
        <TextField id={ids.metric} label="Measured by" optional autoComplete="off" value={metric} onChange={(e) => setMetric(e.target.value)} />
        <TextField id={ids.date} label="Target date" optional type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <FormButtons saving={saving} label="Agree the goal" busy="Saving…" onCancel={onCancel} />
    </form>
  );
}

function GoalRow({ goal, active }: { goal: Dashboard["goals"][number]; active: boolean }) {
  const statusId = useId();
  const invalidate = useInvalidateMentorship();
  const [error, setError] = useState<string | null>(null);
  async function change(status: GoalStatus) {
    setError(null);
    try {
      await updateGoal(goal.id, { status });
      await invalidate();
    } catch (failure) {
      setError(message(failure, "The goal could not be updated."));
    }
  }
  return (
    <li aria-label={goal.title} className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{goal.title}</p>
          <p className="text-xs text-muted-foreground">
            {[goal.targetValue ? `Target ${kes(goal.targetValue)}` : null, goal.targetMetric, goal.targetDate ? `by ${formatDate(goal.targetDate)}` : null].filter(Boolean).join(" · ") || "No target set"}
          </p>
        </div>
        {active && !GOAL_FINAL.has(goal.status) ? (
          <div className="w-40">
            <SelectField id={statusId} label={`Status of ${goal.title}`} value={goal.status} onChange={(v) => void change(v as GoalStatus)}>
              {GOAL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {GOAL_STATUS_LABEL[s]}
                </option>
              ))}
            </SelectField>
          </div>
        ) : (
          <span className="rounded-full border px-2 py-0.5 text-xs">{GOAL_STATUS_LABEL[goal.status]}</span>
        )}
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </li>
  );
}

// ---- KPIs ----

function IndicatorForm({ engagementId, onDone, onCancel }: { engagementId: string; onDone: (note: string) => void; onCancel: () => void }) {
  const ids = { name: useId(), source: useId(), target: useId(), note: useId() };
  const invalidate = useInvalidateMentorship();
  const [source, setSource] = useState<SourceKey>("MONTHLY_REVENUE");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [problems, setProblems] = useState<{ target?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const money = MONEY_SOURCES.has(source);
  async function submit(event: FormEvent) {
    event.preventDefault();
    let problem: string | undefined;
    if (target.trim() === "") problem = money ? "Enter the target in shillings." : "Enter the target, e.g. 35 or 1.5.";
    else if (money) {
      try {
        const cents = parseMajorToCents(target);
        if (cents < 0n && !NEGATIVE_OK.has(source)) problem = "This KPI can’t target a negative amount.";
      } catch {
        problem = "Enter the target in shillings, e.g. 150,000.";
      }
    } else if (!RATE.test(target.trim())) problem = "Enter a number with at most two decimals, e.g. 35 or 1.5.";
    else if (target.trim().startsWith("-") && !NEGATIVE_OK.has(source)) problem = "This KPI can’t target a negative figure.";
    setProblems({ target: problem });
    if (problem) return;
    setSaving(true);
    setError(null);
    try {
      await createIndicator(engagementId, {
        name: name.trim() || SOURCE_LABEL[source],
        sourceKey: source,
        ...(money ? { targetAmount: centsToAmount(parseMajorToCents(target)) } : { targetRate: target.trim() }),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      await invalidate();
      onDone(`KPI “${name.trim() || SOURCE_LABEL[source]}” agreed.`);
    } catch (failure) {
      setError(message(failure, "The KPI could not be saved. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form noValidate aria-label="New KPI" onSubmit={(e) => void submit(e)} className="space-y-3 rounded-lg border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField id={ids.source} label="Measure" value={source} onChange={(v) => setSource(v as SourceKey)} hint="Computed live from the business’s own books — never typed in.">
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </SelectField>
        <TextField id={ids.name} label="Name" optional autoComplete="off" placeholder={SOURCE_LABEL[source]} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField id={ids.target} label={money ? "Target (KES)" : source === "INVENTORY_TURNOVER" ? "Target (times)" : "Target (%)"} inputMode="decimal" autoComplete="off" value={target} error={problems.target} onChange={(e) => setTarget(e.target.value)} />
        <TextField id={ids.note} label="Note" optional autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <FormButtons saving={saving} label="Agree the KPI" busy="Saving…" onCancel={onCancel} />
    </form>
  );
}

const figure = (kind: DashboardIndicator["kind"], amount: string | null, rate: string | null, source: SourceKey) =>
  kind === "AMOUNT" ? (amount === null ? "—" : kes(amount)) : rate === null ? "—" : source === "INVENTORY_TURNOVER" ? `${rate}×` : `${rate}%`;

function LiveActual({ indicator }: { indicator: DashboardIndicator }) {
  const [asked, setAsked] = useState(false);
  const actual = useActual(indicator.id, asked);
  if (!asked)
    return (
      <Button type="button" variant="outline" className="h-11" onClick={() => setAsked(true)} aria-label={`Check ${indicator.name} now`}>
        Check now
      </Button>
    );
  if (actual.isPending) return <span className="text-xs text-muted-foreground">Computing…</span>;
  if (actual.isError) return <span className="text-xs text-destructive">{actual.error.message}</span>;
  const a = actual.data;
  return (
    <span role="status" className="text-xs">
      Now {a.unavailableReason ? `not available — ${a.unavailableReason}` : figure(a.kind, a.actualAmount, a.actualRate, a.sourceKey)} · {formatDateTime(a.computedAt)}
    </span>
  );
}

// ---- Action items ----

function ActionItemForm({ engagementId, onDone, onCancel }: { engagementId: string; onDone: (note: string) => void; onCancel: () => void }) {
  const ids = { title: useId(), party: useId(), due: useId() };
  const invalidate = useInvalidateMentorship();
  const [title, setTitle] = useState("");
  const [party, setParty] = useState<ActionParty>("ENTREPRENEUR");
  const [due, setDue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (title.trim() === "") {
      setProblem("Say what is to be done.");
      return;
    }
    setProblem(null);
    setSaving(true);
    setError(null);
    try {
      await createActionItem(engagementId, { title: title.trim(), responsibleParty: party, ...(due ? { dueDate: due } : {}) });
      await invalidate();
      onDone(`Action item added for the ${PARTY_LABEL[party].toLowerCase()}.`);
    } catch (failure) {
      setError(message(failure, "The action item could not be saved. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form noValidate aria-label="New action item" onSubmit={(e) => void submit(e)} className="space-y-3 rounded-lg border p-3">
      <TextField id={ids.title} label="What is to be done" autoComplete="off" value={title} error={problem ?? undefined} onChange={(e) => setTitle(e.target.value)} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField id={ids.party} label="Who does it" value={party} onChange={(v) => setParty(v as ActionParty)}>
          <option value="ENTREPRENEUR">{PARTY_LABEL.ENTREPRENEUR}</option>
          <option value="MENTOR">{PARTY_LABEL.MENTOR}</option>
        </SelectField>
        <TextField id={ids.due} label="Due" optional type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <FormButtons saving={saving} label="Add the action item" busy="Saving…" onCancel={onCancel} />
    </form>
  );
}

export function ActionItemRow({ item, active, business }: { item: ActionItem; active: boolean; business?: string }) {
  const invalidate = useInvalidateMentorship();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function close(status: "DONE" | "CANCELLED") {
    setSaving(true);
    setError(null);
    try {
      await updateActionItem(item.id, { status });
      await invalidate();
    } catch (failure) {
      setError(message(failure, "The action item could not be updated."));
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
            {business ? `${business} · ` : ""}
            {PARTY_LABEL[item.responsibleParty]}
            {item.dueDate ? ` · due ${formatDate(item.dueDate)}` : ""}
            {item.completedAt ? ` · done ${formatDate(item.completedAt)}` : ""}
          </p>
        </div>
        <span className="rounded-full border px-2 py-0.5 text-xs">{ITEM_STATUS_LABEL[item.status]}</span>
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {active && item.status === "OPEN" ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="h-11" disabled={saving} onClick={() => void close("DONE")} aria-label={`Mark “${item.title}” done`}>
            Mark done
          </Button>
          <Button type="button" variant="outline" className="h-11" disabled={saving} onClick={() => void close("CANCELLED")} aria-label={`Cancel “${item.title}”`}>
            Cancel item
          </Button>
        </div>
      ) : null}
    </li>
  );
}

// ---- Sessions ----

function SessionForm({ engagementId, onDone, onCancel }: { engagementId: string; onDone: (note: string) => void; onCancel: () => void }) {
  const ids = { date: useId(), summary: useId(), observations: useId(), commitments: useId() };
  const invalidate = useInvalidateMentorship();
  const [date, setDate] = useState(businessToday());
  const [summary, setSummary] = useState("");
  const [observations, setObservations] = useState("");
  const [commitments, setCommitments] = useState("");
  const [problems, setProblems] = useState<{ date?: string; summary?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: typeof problems = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) next.date = "Enter the day it took place.";
    else if (date > businessToday()) next.date = "A session can’t be dated in the future.";
    if (summary.trim() === "") next.summary = "Summarise the session.";
    setProblems(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      await createSession(engagementId, { sessionDate: date, summary: summary.trim(), ...(observations.trim() ? { observations: observations.trim() } : {}), ...(commitments.trim() ? { commitments: commitments.trim() } : {}) });
      await invalidate();
      onDone(`Session of ${formatDate(date)} recorded.`);
    } catch (failure) {
      setError(message(failure, "The session could not be saved. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form noValidate aria-label="Record a session" onSubmit={(e) => void submit(e)} className="space-y-3 rounded-lg border p-3">
      <TextField id={ids.date} label="Date" type="date" value={date} error={problems.date} onChange={(e) => setDate(e.target.value)} />
      <TextField id={ids.summary} label="Summary" autoComplete="off" value={summary} error={problems.summary} onChange={(e) => setSummary(e.target.value)} />
      <TextField id={ids.observations} label="Observations" optional autoComplete="off" value={observations} onChange={(e) => setObservations(e.target.value)} />
      <TextField id={ids.commitments} label="Commitments" optional autoComplete="off" value={commitments} onChange={(e) => setCommitments(e.target.value)} />
      <p className="text-xs text-muted-foreground">A recorded session can’t be edited — a correction is a new session.</p>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <FormButtons saving={saving} label="Record the session" busy="Saving…" onCancel={onCancel} />
    </form>
  );
}

function SessionDetail({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId);
  if (session.isPending) return <LoadingState label="Loading the session" lines={3} />;
  if (session.isError) return <ErrorState title="Couldn’t load the session" description={session.error.message} onRetry={() => void session.refetch()} />;
  const s = session.data;
  return (
    <dl className="space-y-3 text-sm">
      {(
        [
          ["Date", formatDate(s.sessionDate)],
          ["Summary", s.summary],
          ["Observations", s.observations],
          ["Commitments", s.commitments],
        ] as const
      ).map(([k, v]) => (
        <div key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="whitespace-pre-wrap">{v ?? "None recorded"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SessionRow({ session, onOpen, business }: { session: Session; onOpen: (id: string) => void; business?: string }) {
  return (
    <li>
      <button type="button" onClick={() => onOpen(session.id)} className="flex min-h-11 w-full flex-col rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium">
          {formatDate(session.sessionDate)}
          {business ? ` · ${business}` : ""}
        </span>
        <span className="line-clamp-2 text-muted-foreground">{session.summary}</span>
      </button>
    </li>
  );
}

// ---- One engagement ----

function EndEngagement({ engagement, onEnded }: { engagement: Engagement; onEnded: (note: string) => void }) {
  const ids = { title: useId(), reason: useId() };
  const invalidate = useInvalidateMentorship();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      await endEngagement(engagement.id, reason.trim() || undefined);
      await invalidate();
      onEnded(`The engagement with ${engagement.businessName} has ended. Its records stay readable; nothing more of the business’s figures can be read.`);
    } catch (failure) {
      setError(message(failure, "The engagement could not be ended. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  if (!asking)
    return (
      <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(true)}>
        End engagement
      </Button>
    );
  return (
    <div role="alertdialog" aria-labelledby={ids.title} className="space-y-2 rounded-md border p-3 text-sm">
      <p id={ids.title} className="font-medium">
        End the engagement with {engagement.businessName}?
      </p>
      <p>It is final. A new engagement needs a new invitation and the owner’s consent again.</p>
      <TextField id={ids.reason} label="Why" optional autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
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

type Adding = "goal" | "kpi" | "item" | "session" | null;

function EngagementWorkspace({ engagement, onEnded }: { engagement: Engagement; onEnded: (note: string) => void }) {
  const dashboard = useDashboard(engagement.id);
  const [section, setSection] = useState("overview");
  const [adding, setAdding] = useState<Adding>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [showSnapshot, setShowSnapshot] = useState(false);
  if (dashboard.isPending) return <LoadingState label="Loading the engagement" lines={5} />;
  if (dashboard.isError) return <ErrorState title="Couldn’t open the engagement" description={dashboard.error.message} onRetry={() => void dashboard.refetch()} />;
  const d = dashboard.data;
  const done = (note: string) => {
    setAdding(null);
    setNotice(note);
  };
  const tabs: Tab[] = [
    { id: "overview", label: "Overview" },
    { id: "goals", label: "Goals" },
    { id: "kpis", label: "KPIs" },
    { id: "items", label: "Action items" },
    { id: "sessions", label: "Sessions" },
  ];
  const addButton = (kind: Exclude<Adding, null>, label: string) =>
    adding === kind ? null : (
      <Button type="button" className="h-11" onClick={() => setAdding(kind)}>
        {label}
      </Button>
    );
  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      <p className="text-sm text-muted-foreground">
        Consented {d.engagement.consentGivenAt ? formatDate(d.engagement.consentGivenAt) : ""} · figures for {formatDate(d.period.from)} – {formatDate(d.period.to)}. Every read of the business’s figures is shown to its owner.
      </p>
      <Tabs tabs={tabs} active={section} onChange={setSection} label={`Engagement with ${engagement.businessName}`} />
      <TabPanel id={section}>
        {section === "overview" ? (
          <div className="space-y-4">
            {showSnapshot ? (
              <SnapshotView engagementId={engagement.id} />
            ) : (
              <Button type="button" variant="outline" className="h-11" onClick={() => setShowSnapshot(true)}>
                Read this month’s figures
              </Button>
            )}
            <section aria-label="KPI standings" className="space-y-2">
              <h3 className="font-medium">KPIs against target</h3>
              {d.indicators.length === 0 ? <p className="text-sm text-muted-foreground">No KPIs agreed yet.</p> : null}
              <ul className="space-y-2">
                {d.indicators.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                    <span>
                      <span className="font-medium">{i.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        Target {figure(i.kind, i.targetAmount, i.targetRate, i.sourceKey)} · actual {i.unavailableReason ? "not available" : figure(i.kind, i.actualAmount, i.actualRate, i.sourceKey)}
                      </span>
                    </span>
                    <span className={cn("rounded-full border px-2 py-0.5 text-xs", i.standing === "ON_TARGET" ? "border-emerald-700/40 bg-emerald-700/10" : i.standing === "OFF_TARGET" ? "border-destructive/40 bg-destructive/10" : "")}>{STANDING_LABEL[i.standing]}</span>
                  </li>
                ))}
              </ul>
            </section>
            <p className="text-sm">
              {d.actionItems.open.length.toString()} open action items · {d.sessionCount.toString()} sessions · {d.goals.length.toString()} goals
            </p>
            <EndEngagement engagement={engagement} onEnded={onEnded} />
          </div>
        ) : null}
        {section === "goals" ? (
          <div className="space-y-3">
            {addButton("goal", "Agree a goal")}
            {adding === "goal" ? <GoalForm engagementId={engagement.id} onDone={done} onCancel={() => setAdding(null)} /> : null}
            {d.goals.length === 0 ? <EmptyState title="No goals yet" description="Agree the first goal with the owner." /> : null}
            <ul aria-label="Goals" className="space-y-2">
              {d.goals.map((g) => (
                <GoalRow key={g.id} goal={g} active />
              ))}
            </ul>
          </div>
        ) : null}
        {section === "kpis" ? (
          <div className="space-y-3">
            {addButton("kpi", "Agree a KPI")}
            {adding === "kpi" ? <IndicatorForm engagementId={engagement.id} onDone={done} onCancel={() => setAdding(null)} /> : null}
            {d.indicators.length === 0 ? <EmptyState title="No KPIs yet" description="A KPI is computed live from the business’s books." /> : null}
            <ul aria-label="KPIs" className="space-y-2">
              {d.indicators.map((i) => (
                <li key={i.id} aria-label={i.name} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                  <span>
                    <span className="font-medium">{i.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {SOURCE_LABEL[i.sourceKey]} · target {figure(i.kind, i.targetAmount, i.targetRate, i.sourceKey)}
                    </span>
                  </span>
                  <LiveActual indicator={i} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {section === "items" ? (
          <div className="space-y-3">
            {addButton("item", "Add an action item")}
            {adding === "item" ? <ActionItemForm engagementId={engagement.id} onDone={done} onCancel={() => setAdding(null)} /> : null}
            <ul aria-label="Open action items" className="space-y-2">
              {d.actionItems.open.map((item) => (
                <ActionItemRow key={item.id} item={item} active />
              ))}
            </ul>
            {d.actionItems.closed.length > 0 ? (
              <ul aria-label="Closed action items" className="space-y-2">
                {d.actionItems.closed.map((item) => (
                  <ActionItemRow key={item.id} item={item} active={false} />
                ))}
              </ul>
            ) : null}
            {d.actionItems.open.length + d.actionItems.closed.length === 0 ? <EmptyState title="No action items yet" description="Add what the owner or you will do next." /> : null}
          </div>
        ) : null}
        {section === "sessions" ? (
          <div className="space-y-3">
            {addButton("session", "Record a session")}
            {adding === "session" ? <SessionForm engagementId={engagement.id} onDone={done} onCancel={() => setAdding(null)} /> : null}
            {d.recentSessions.length === 0 ? <EmptyState title="No sessions yet" description="Record each coaching session after it happens." /> : null}
            <ul aria-label="Sessions" className="space-y-2">
              {d.recentSessions.map((s) => (
                <SessionRow key={s.id} session={s} onOpen={setSession} />
              ))}
            </ul>
            {session ? (
              <section aria-label="Session" className="rounded-lg border p-3">
                <SessionDetail sessionId={session} />
              </section>
            ) : null}
          </div>
        ) : null}
      </TabPanel>
    </div>
  );
}

function EngagementSheet({ engagement, onClose, onEnded }: { engagement: Engagement; onClose: () => void; onEnded: (note: string) => void }) {
  return (
    <Sheet key={engagement.id} title={engagement.businessName} onClose={onClose} wide>
      {engagement.status === "ACTIVE" ? (
        <EngagementWorkspace engagement={engagement} onEnded={onEnded} />
      ) : engagement.status === "INVITED" ? (
        <EmptyState title="Waiting for the owner’s consent" description={`Nothing of ${engagement.businessName}’s figures can be read until its owner consents to this engagement.`} />
      ) : (
        <EmptyState title="This engagement has ended" description={`Ended ${engagement.endedAt ? formatDate(engagement.endedAt) : ""}${engagement.endedReason ? ` — ${engagement.endedReason}` : ""}. Nothing more of the business’s figures can be read.`} />
      )}
    </Sheet>
  );
}

function EngagementList({ engagements, onOpen }: { engagements: readonly Engagement[]; onOpen: (e: Engagement) => void }) {
  return (
    <ul aria-label="Engagements" className="space-y-2">
      {engagements.map((e) => (
        <li key={e.id}>
          <button
            type="button"
            onClick={() => onOpen(e)}
            aria-label={`${e.businessName} · ${ENGAGEMENT_STATUS_LABEL[e.status]}`}
            className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>
              <span className="font-medium">{e.businessName}</span>
              <span className="block text-xs text-muted-foreground">
                {e.startedAt ? `Since ${formatDate(e.startedAt)}` : `Invited ${formatDate(e.createdAt)}`}
                {e.endedAt ? ` · ended ${formatDate(e.endedAt)}` : ""}
              </span>
            </span>
            <EngagementBadge status={e.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Page({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Greeting />
        <h1 className="font-display text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{intro}</p>
      </div>
      {children}
    </div>
  );
}

/** /mentorship (and /mentorship/mentees with `onlyActive`): the mentor's engagements. */
export function MentorEngagements({ onlyActive = false }: { onlyActive?: boolean }) {
  const engagements = useEngagements();
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = engagements.data?.data.filter((e) => !onlyActive || e.status === "ACTIVE") ?? [];
  const open = engagements.data?.data.find((e) => e.id === openId) ?? null;
  return (
    <Page title={onlyActive ? "Mentees" : "My engagements"} intro={onlyActive ? "The businesses whose owners have consented to your mentoring." : "Every business you have been invited to mentor. Figures open only once the owner consents."}>
      {notice ? <Done>{notice}</Done> : null}
      {engagements.isPending ? <LoadingState label="Loading engagements" lines={4} /> : null}
      {engagements.isError ? <ErrorState title="Couldn’t load your engagements" description={engagements.error.message} onRetry={() => void engagements.refetch()} /> : null}
      {engagements.isSuccess && list.length === 0 ? <EmptyState title={onlyActive ? "No consented mentees yet" : "No engagements yet"} description="A programme officer invites you to a business; its owner then consents." /> : null}
      {list.length > 0 ? <EngagementList engagements={list} onOpen={(e) => setOpenId(e.id)} /> : null}
      {open ? (
        <EngagementSheet
          engagement={open}
          onClose={() => setOpenId(null)}
          onEnded={(note) => {
            setOpenId(null);
            setNotice(note);
          }}
        />
      ) : null}
    </Page>
  );
}

/** /mentorship/action-items: the open action plan across every active engagement. */
export function MentorActionItems() {
  const engagements = useEngagements();
  const active = engagements.data?.data.filter((e) => e.status === "ACTIVE") ?? [];
  const lists = useAcrossEngagements<ActionItem>(active, "items");
  const loading = engagements.isPending || lists.some((l) => l.isPending);
  const failed = engagements.error ?? lists.find((l) => l.isError)?.error ?? null;
  const rows = lists.flatMap((l) => (l.data ? l.data.data.map((item) => ({ item, engagement: l.data.engagement })) : []));
  const open = rows.filter((r) => r.item.status === "OPEN").sort((a, b) => (a.item.dueDate ?? "9999").localeCompare(b.item.dueDate ?? "9999"));
  return (
    <Page title="Action items" intro="Open action items across all your active engagements, soonest due first.">
      {loading ? <LoadingState label="Loading action items" lines={4} /> : null}
      {failed ? <ErrorState title="Couldn’t load the action items" description={failed.message} onRetry={() => void engagements.refetch()} /> : null}
      {!loading && !failed && open.length === 0 ? <EmptyState title="Nothing open" description="Add action items from an engagement." /> : null}
      {open.length > 0 ? (
        <ul aria-label="Open action items" className="space-y-2">
          {open.map(({ item, engagement }) => (
            <ActionItemRow key={item.id} item={item} active business={engagement.businessName} />
          ))}
        </ul>
      ) : null}
    </Page>
  );
}

/** /mentorship/sessions: every recorded session, and recording one for a chosen engagement. */
export function MentorSessions() {
  const engagementId = useId();
  const engagements = useEngagements();
  const active = engagements.data?.data.filter((e) => e.status === "ACTIVE") ?? [];
  const lists = useAcrossEngagements<Session>(active, "sessions");
  const [recordFor, setRecordFor] = useState("");
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const loading = engagements.isPending || lists.some((l) => l.isPending);
  const rows = lists.flatMap((l) => (l.data ? l.data.data.map((s) => ({ session: s, engagement: l.data.engagement })) : [])).sort((a, b) => b.session.sessionDate.localeCompare(a.session.sessionDate));
  return (
    <Page title="Sessions" intro="Your coaching sessions with each business, newest first.">
      {notice ? <Done>{notice}</Done> : null}
      {active.length > 0 ? (
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="sm:w-72">
              <SelectField id={engagementId} label="Business" value={recordFor} onChange={setRecordFor}>
                <option value="">Choose a business…</option>
                {active.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.businessName}
                  </option>
                ))}
              </SelectField>
            </div>
            <Button type="button" className="h-11" disabled={recordFor === ""} onClick={() => setRecording(true)}>
              Record a session
            </Button>
          </div>
          {recording && recordFor ? (
            <SessionForm
              engagementId={recordFor}
              onCancel={() => setRecording(false)}
              onDone={(note) => {
                setRecording(false);
                setNotice(note);
              }}
            />
          ) : null}
        </div>
      ) : null}
      {loading ? <LoadingState label="Loading sessions" lines={4} /> : null}
      {!loading && rows.length === 0 ? <EmptyState title="No sessions yet" description={active.length === 0 ? "Sessions are recorded once an owner has consented to an engagement." : "Record the first one above."} /> : null}
      {rows.length > 0 ? (
        <ul aria-label="Sessions" className="space-y-2">
          {rows.map(({ session, engagement }) => (
            <SessionRow key={session.id} session={session} business={engagement.businessName} onOpen={setOpen} />
          ))}
        </ul>
      ) : null}
      {open ? (
        <Sheet key={open} title="Coaching session" onClose={() => setOpen(null)}>
          <SessionDetail sessionId={open} />
        </Sheet>
      ) : null}
    </Page>
  );
}

/** /mentorship/cohort: each consented business's headline figures, side by side — never summed. */
export function MentorCohort() {
  const cohort = useCohort();
  return (
    <Page title="Cohort" intro="Each business you mentor, month to date. Each line is read from that business alone and logged to its owner; figures are never added up across businesses.">
      {cohort.isPending ? <LoadingState label="Reading your cohort" lines={4} /> : null}
      {cohort.isError ? <ErrorState title="Couldn’t load your cohort" description={cohort.error.message} onRetry={() => void cohort.refetch()} /> : null}
      {cohort.isSuccess && cohort.data.members.length === 0 ? <EmptyState title="No consented businesses yet" description="A business joins your cohort once its owner consents." /> : null}
      {cohort.isSuccess && cohort.data.members.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">Cohort, month to date, in Kenya shillings</caption>
            <thead>
              <tr className="border-b bg-muted/40 text-right text-xs text-muted-foreground">
                <th scope="col" className="p-2 text-left font-medium">
                  Business
                </th>
                <th scope="col" className="p-2 font-medium">
                  Revenue
                </th>
                <th scope="col" className="p-2 font-medium">
                  Cash position
                </th>
                <th scope="col" className="p-2 font-medium">
                  Gross margin
                </th>
                <th scope="col" className="p-2 font-medium">
                  Open items
                </th>
              </tr>
            </thead>
            <tbody>
              {cohort.data.members.map((m) => (
                <tr key={m.engagement.id} className="border-b text-right tabular-nums last:border-b-0">
                  <th scope="row" className="p-2 text-left font-normal">
                    {m.engagement.businessName}
                  </th>
                  <td className="p-2">{formatKES(m.revenue)}</td>
                  <td className="p-2">{formatKES(m.cashPosition)}</td>
                  <td className="p-2">{m.grossMarginPct === null ? "—" : `${m.grossMarginPct}%`}</td>
                  <td className="p-2">{m.openActionItems.toString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Page>
  );
}
