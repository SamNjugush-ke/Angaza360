"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { Greeting } from "@/components/shell/greeting";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { actionWords, JOB_LABEL, PROVIDER_LABEL, useOverview, type Overview } from "@/lib/admin/console";
import { APPLICATION_STATUS_LABEL, TENANT_STATUS_LABEL, type AdminPermissions, type ApplicationStatus, type TenantStatus } from "@/lib/admin/admin";
import { formatDateTime, formatTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { Ago, Figure, healthTone, Panel, runTone, StatusMark } from "./console/kit";

// THE EXECUTIVE OVERVIEW (M4.5 W5) — the Command Center's landing. One read
// (GET /v1/platform-reports/overview), laid out as an instrument panel: three headline ledgers
// (businesses, the applications pipeline, accounts), the integration-health and job-health strips,
// and the recent-activity feed. Every figure is the server's and every element links to the
// screen that lists the same rows, so a tile and its detail always agree (the server proves it).

const STATUS_ORDER: TenantStatus[] = ["ACTIVE", "SUSPENDED", "PENDING_PROVISIONING", "DEACTIVATED"];
const STATUS_BAR: Readonly<Record<TenantStatus, string>> = {
  ACTIVE: "bg-primary",
  SUSPENDED: "bg-angaza-gold",
  PENDING_PROVISIONING: "bg-angaza-lightTeal",
  DEACTIVATED: "bg-muted-foreground/40",
};
const PIPELINE: ApplicationStatus[] = ["SUBMITTED", "UNDER_REVIEW", "NEEDS_CHANGES", "APPROVED", "REJECTED"];
const PIPELINE_BAR: Readonly<Record<string, string>> = {
  SUBMITTED: "bg-angaza-gold",
  UNDER_REVIEW: "bg-primary",
  NEEDS_CHANGES: "bg-angaza-support",
  APPROVED: "bg-success",
  REJECTED: "bg-muted-foreground/40",
};

/** A proportional bar of counts, with the words beside it (the bar is decoration; the list is the data). */
function Breakdown({ label, parts }: { label: string; parts: Array<{ key: string; name: string; count: number; bar: string; href?: string }> }) {
  const total = parts.reduce((a, p) => a + p.count, 0);
  return (
    <div className="space-y-2">
      <div aria-hidden className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        {total > 0 ? parts.filter((p) => p.count > 0).map((p) => <span key={p.key} className={p.bar} style={{ width: `${((p.count / total) * 100).toFixed(2)}%` }} />) : null}
      </div>
      <ul aria-label={label} className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center justify-between gap-2">
            {p.href ? (
              <Link href={p.href} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline">
                <span aria-hidden className={cn("size-2 rounded-[2px]", p.bar)} />
                {p.name}
              </Link>
            ) : (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span aria-hidden className={cn("size-2 rounded-[2px]", p.bar)} />
                {p.name}
              </span>
            )}
            <Figure>{p.count.toLocaleString("en-KE")}</Figure>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Ledger({ label, figure, sub, href, linkLabel, children }: { label: string; figure: string; sub: string; href: string; linkLabel: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-sm font-semibold">{label}</h2>
        <Link href={href} className="min-h-11 content-center text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {linkLabel}
        </Link>
      </div>
      <p className="flex items-baseline gap-2">
        <Figure className="text-4xl font-semibold leading-none text-foreground">{figure}</Figure>
        <span className="text-xs text-muted-foreground">{sub}</span>
      </p>
      {children}
    </div>
  );
}

function Headlines({ o }: { o: Overview }) {
  const b = o.businesses;
  const a = o.applications;
  const u = o.users;
  const share = u.activeAccounts > 0 ? Math.round((u.signedInLast30Days / u.activeAccounts) * 100) : 0;
  return (
    <div className="grid divide-y rounded-lg border bg-card md:grid-cols-3 md:divide-x md:divide-y-0">
      <Ledger label="Businesses" figure={b.total.toLocaleString("en-KE")} sub={`${(b.byStatus.ACTIVE ?? 0).toLocaleString("en-KE")} active`} href="/admin/tenants" linkLabel="Tenants">
        <Breakdown
          label="Businesses by status"
          parts={STATUS_ORDER.map((s) => ({ key: s, name: TENANT_STATUS_LABEL[s], count: b.byStatus[s] ?? 0, bar: STATUS_BAR[s], href: `/admin/tenants?status=${s}` }))}
        />
      </Ledger>
      <Ledger label="Applications" figure={a.awaitingStaff.toLocaleString("en-KE")} sub="waiting on staff" href="/admin/applications" linkLabel="Queue">
        <p className="text-xs text-muted-foreground">
          {a.oldestAwaitingDays === null ? (
            "Nothing is waiting."
          ) : (
            <>
              Oldest waiting <Figure className="text-foreground">{a.oldestAwaitingDays.toString()}</Figure> {a.oldestAwaitingDays === 1 ? "day" : "days"}
              {a.oldestAwaitingSince ? <> — since {formatDateTime(a.oldestAwaitingSince)}</> : null}
            </>
          )}
        </p>
        <Breakdown label="Applications by status" parts={PIPELINE.map((s) => ({ key: s, name: APPLICATION_STATUS_LABEL[s], count: a.byStatus[s] ?? 0, bar: PIPELINE_BAR[s] ?? "bg-muted", href: `/admin/applications?status=${s}` }))} />
      </Ledger>
      <Ledger label="Accounts" figure={u.activeAccounts.toLocaleString("en-KE")} sub="active" href="/admin/users" linkLabel="Users">
        <div className="space-y-1">
          <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
            <span className="block h-full bg-primary" style={{ width: `${share.toString()}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            <Figure className="text-foreground">{u.signedInLast30Days.toLocaleString("en-KE")}</Figure> signed in within 30 days (<Figure>{share.toString()}%</Figure>)
          </p>
          <p className="text-xs text-muted-foreground">
            <Figure>{u.platformStaff.toLocaleString("en-KE")}</Figure> platform accounts · <Figure>{u.inactiveAccounts.toLocaleString("en-KE")}</Figure> deactivated
          </p>
        </div>
      </Ledger>
    </div>
  );
}

function IntegrationStrip({ o }: { o: Overview }) {
  const { businesses, platform } = o.integrations;
  return (
    <Panel title="Integration health" href="/admin/integrations" linkLabel="Health board" description="Each business’s last check, and Angaza’s own notification credentials.">
      <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr]">
        <ul aria-label="Business integrations" className="space-y-2">
          {businesses.length === 0 ? <li className="text-sm text-muted-foreground">No business has checked an integration yet.</li> : null}
          {businesses.map((row) => (
            <li key={row.provider} className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">{PROVIDER_LABEL[row.provider] ?? row.provider}</span>
              <span className="flex items-center gap-3">
                <StatusMark tone="ok">
                  <Figure>{row.healthy.toString()}</Figure> healthy
                </StatusMark>
                <StatusMark tone={row.failing > 0 ? "bad" : "idle"}>
                  <Figure>{row.failing.toString()}</Figure> failing
                </StatusMark>
              </span>
            </li>
          ))}
        </ul>
        <div aria-hidden className="hidden w-px bg-border md:block" />
        <ul aria-label="Platform notification credentials" className="space-y-2">
          {platform.length === 0 ? <li className="text-sm text-muted-foreground">No platform credential is stored.</li> : null}
          {platform.map((row) => (
            <li key={`${row.provider}-${row.environment}`} className="flex items-center justify-between gap-3 text-sm">
              <span>
                <span className="font-medium">{PROVIDER_LABEL[row.provider] ?? row.provider}</span> <span className="text-xs text-muted-foreground">{row.environment}</span>
              </span>
              <span className="flex items-center gap-3">
                <StatusMark tone={row.status === "ACTIVE" ? "ok" : "idle"}>{row.status.toLowerCase()}</StatusMark>
                <StatusMark tone={healthTone(row.healthStatus)}>{row.healthStatus.toLowerCase()}</StatusMark>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function JobStrip({ o }: { o: Overview }) {
  return (
    <Panel title="Scheduled jobs" href="/admin/jobs" linkLabel="All jobs" description={`${o.jobs.failedLast24h.toString()} failed run${o.jobs.failedLast24h === 1 ? "" : "s"} in the last 24 hours.`}>
      <ul aria-label="Jobs" className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {o.jobs.list.map((job) => (
          <li key={job.name} className="bg-card">
            <Link href={`/admin/jobs?job=${encodeURIComponent(job.name)}`} className="flex min-h-11 h-full flex-col gap-1 p-3 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <span className="text-sm font-medium">{JOB_LABEL[job.name] ?? job.name}</span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <StatusMark tone={runTone(job.lastStatus)}>{job.lastStatus ? job.lastStatus.toLowerCase() : "not run yet"}</StatusMark>
                <Ago at={job.lastStartedAt} />
                {job.failedLast24h > 0 ? (
                  <span className="text-destructive">
                    <Figure>{job.failedLast24h.toString()}</Figure> failed today
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Activity({ o }: { o: Overview }) {
  return (
    <Panel title="Recent activity" href="/admin/audit" linkLabel="Audit log">
      {o.recentActivity.length === 0 ? <p className="text-sm text-muted-foreground">Nothing recorded yet.</p> : null}
      <ol aria-label="Recent activity" className="relative space-y-3 border-l pl-4">
        {o.recentActivity.map((event) => (
          <li key={event.id} className="relative text-sm">
            <span aria-hidden className="absolute -left-[1.3rem] top-1.5 size-2 rounded-[2px] bg-primary" />
            <span className="block">
              <span className="font-medium">{event.actorName ?? (event.actorUserId ? "A removed user" : "Someone (not signed in)")}</span> {actionWords(event.action)}
              {event.targetName ? <> — {event.targetName}</> : null}
            </span>
            <span className="text-xs text-muted-foreground">
              <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time>
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export function AdminOverview({ permissions }: { permissions: AdminPermissions }) {
  const overview = useOverview();
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <Greeting />
          <h1 className="font-display text-2xl font-semibold tracking-tight">Command Center</h1>
          <p className="text-sm text-muted-foreground">
            {permissions.isSuperAdmin ? "The platform at a glance — every figure links to its detail." : "The platform at a glance — onboarding, programmes and operations."}
            {overview.data ? (
              <>
                {" "}
                As at <time dateTime={overview.data.generatedAt}>{formatTime(overview.data.generatedAt)}</time>, Nairobi time.
              </>
            ) : null}
          </p>
        </div>
        <Button type="button" variant="outline" className="h-11" onClick={() => void overview.refetch()} disabled={overview.isFetching}>
          <RefreshCw className={cn("size-4", overview.isFetching ? "animate-spin motion-reduce:animate-none" : "")} aria-hidden /> {overview.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {overview.isPending ? <LoadingState label="Loading the overview" lines={5} /> : null}
      {overview.isError ? <ErrorState title="Couldn’t load the overview" description={overview.error.message} onRetry={() => void overview.refetch()} /> : null}
      {overview.data ? (
        <>
          <Headlines o={overview.data} />
          <IntegrationStrip o={overview.data} />
          <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
            <JobStrip o={overview.data} />
            <Activity o={overview.data} />
          </div>
        </>
      ) : null}
    </div>
  );
}
