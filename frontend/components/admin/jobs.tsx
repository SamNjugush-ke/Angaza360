"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { consoleKeys, JOB_LABEL, newIdempotencyKey, runJob, useJobRuns, useJobs, type Job, type JobRun } from "@/lib/admin/console";
import type { AdminPermissions } from "@/lib/admin/admin";
import { formatDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { Ago, Figure, Panel, runTone, StatusMark, useStepUp } from "./console/kit";
import { Confirm, ErrorLine, Page } from "./shared";

// JOBS (M4.5 W5): the maintenance jobs the scheduler runs — what each does, its suggested cadence
// (the real schedule is Cloud Scheduler's configuration), its last run and its history, each run's
// outcome, attempts and reason. A SUPER_ADMIN can run one NOW from here: confirmed, behind a fresh
// step-up, sent with ONE idempotency key per decision — so a double click or the step-up retry is the
// same run, never two. The same runner as the scheduler: the job's lock, bounded retries, a recorded
// run (trigger "console", naming the administrator). The machine trigger's secret never reaches here.

const TRIGGER_WORD: Readonly<Record<string, string>> = { SCHEDULER: "scheduler", CLI: "operator (CLI)", CONSOLE: "console" };

function summaryWords(summary: Record<string, number> | null): string {
  if (summary === null) return "";
  const entries = Object.entries(summary);
  if (entries.length === 0) return "nothing to do";
  return entries.map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()} ${v.toString()}`).join(", ");
}

function RunRow({ run }: { run: JobRun }) {
  return (
    <tr className="border-b align-top last:border-b-0">
      <th scope="row" className="py-2 pr-3 text-left font-normal">
        <time dateTime={run.startedAt}>{formatDateTime(run.startedAt)}</time>
      </th>
      <td className="py-2 pr-3">
        <StatusMark tone={runTone(run.status)}>{run.status.toLowerCase()}</StatusMark>
      </td>
      <td className="py-2 pr-3 text-xs">{TRIGGER_WORD[run.trigger] ?? run.trigger.toLowerCase()}</td>
      <td className="py-2 pr-3">
        <Figure>{run.attempts.toString()}</Figure>
      </td>
      <td className="py-2 text-xs">{run.error ?? summaryWords(run.summary as Record<string, number> | null) ?? ""}</td>
    </tr>
  );
}

function RunNow({ job, onRan }: { job: Job; onRan: (run: JobRun) => void }) {
  const queryClient = useQueryClient();
  const { guard, prompt } = useStepUp();
  const [asking, setAsking] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    // ONE key per decision: the step-up retry, a double click or a network retry is the same run.
    const decision = key ?? newIdempotencyKey();
    setKey(decision);
    setBusy(true);
    setError(null);
    try {
      await guard(async () => {
        const result = await runJob(job.name, decision);
        setAsking(false);
        setKey(null);
        onRan(result);
        await queryClient.invalidateQueries({ queryKey: consoleKeys.all });
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The job could not be started.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      {asking ? (
        <Confirm title={`Run “${JOB_LABEL[job.name] ?? job.name}” now?`} yes="Yes, run it now" busy={busy || prompt !== null} onBack={() => { setAsking(false); setKey(null); }} onYes={() => void run()}>
          <p>It runs exactly as the scheduler would — under the job’s lock, with bounded retries — and the run is recorded with your name. Running it again does no harm: every job only does what is still due.</p>
        </Confirm>
      ) : (
        <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(true)}>
          Run now
        </Button>
      )}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {prompt}
    </div>
  );
}

function JobDetail({ job, permissions }: { job: Job; permissions: AdminPermissions }) {
  const runs = useJobRuns({ jobName: job.name, take: 20 });
  const [result, setResult] = useState<JobRun | null>(null);
  return (
    <Panel title={JOB_LABEL[job.name] ?? job.name} description={job.description}>
      <div className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Job</dt>
            <dd>
              <Figure>{job.name}</Figure>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Schedule</dt>
            <dd>{job.suggestedSchedule} <span className="text-xs text-muted-foreground">(set in Cloud Scheduler)</span></dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Last run</dt>
            <dd className="flex items-center gap-2">
              <StatusMark tone={runTone(job.lastRun?.status)}>{job.lastRun ? job.lastRun.status.toLowerCase() : "not run yet"}</StatusMark>
              <span className="text-xs text-muted-foreground">
                <Ago at={job.lastRun?.startedAt} />
              </span>
            </dd>
          </div>
        </dl>
        {job.lastRun?.status === "FAILED" && job.lastRun.error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
            <span className="font-medium">Last failure:</span> {job.lastRun.error}
          </p>
        ) : null}
        {permissions.isSuperAdmin ? <RunNow job={job} onRan={setResult} /> : <p className="text-sm text-muted-foreground">A super-administrator can run a job by hand.</p>}
        {result ? (
          <p role="status" className={cn("rounded-md border px-3 py-2 text-sm", result.status === "FAILED" ? "border-destructive/40 bg-destructive/5" : "border-success/40 bg-success/5")}>
            {result.status === "SUCCEEDED"
              ? `It ran and finished: ${summaryWords(result.summary as Record<string, number> | null) || "nothing to do"}.`
              : result.status === "SKIPPED"
                ? `It was not run: ${result.error ?? "another run of it was still in progress"}.`
                : `It failed after ${result.attempts.toString()} attempts: ${result.error ?? "no reason recorded"}.`}
          </p>
        ) : null}
        <section aria-label="Run history" className="space-y-2">
          <h3 className="text-sm font-semibold">Run history</h3>
          {runs.isPending ? <LoadingState label="Loading runs" lines={2} /> : null}
          {runs.isError ? <ErrorState title="Couldn’t load the runs" description={runs.error.message} onRetry={() => void runs.refetch()} /> : null}
          {runs.data && runs.data.data.length === 0 ? <p className="text-sm text-muted-foreground">It has not run yet.</p> : null}
          {runs.data && runs.data.data.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Runs of {job.name}, newest first</caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">Started</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Outcome</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Trigger</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Attempts</th>
                    <th scope="col" className="py-2 font-medium">What it did / why it failed</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.data.map((run) => (
                    <RunRow key={run.id} run={run} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
    </Panel>
  );
}

export function Jobs({ permissions, initialJob }: { permissions: AdminPermissions; initialJob?: string }) {
  const jobs = useJobs();
  const [selected, setSelected] = useState<string | null>(initialJob ?? null);
  const list = jobs.data?.data ?? [];
  const job = list.find((j) => j.name === selected) ?? list[0] ?? null;
  return (
    <Page title="Jobs" intro="The platform’s maintenance jobs: what each does, when it last ran, and how it went.">
      {jobs.isPending ? <LoadingState label="Loading the jobs" lines={4} /> : null}
      {jobs.isError ? <ErrorState title="Couldn’t load the jobs" description={jobs.error.message} onRetry={() => void jobs.refetch()} /> : null}
      {jobs.isSuccess && list.length === 0 ? <EmptyState title="No jobs" description="None are registered." /> : null}
      {job ? (
        <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav aria-label="Jobs">
            <ul className="divide-y rounded-lg border bg-card">
              {list.map((j) => (
                <li key={j.name}>
                  <button
                    type="button"
                    aria-current={j.name === job.name ? "true" : undefined}
                    onClick={() => setSelected(j.name)}
                    className={cn("flex min-h-11 w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", j.name === job.name ? "bg-primary/5 font-medium" : "")}
                  >
                    <span>{JOB_LABEL[j.name] ?? j.name}</span>
                    <span className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
                      <StatusMark tone={runTone(j.lastRun?.status)}>{j.lastRun ? j.lastRun.status.toLowerCase() : "not run yet"}</StatusMark>
                      <Ago at={j.lastRun?.startedAt} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <JobDetail key={job.name} job={job} permissions={permissions} />
        </div>
      ) : null}
    </Page>
  );
}
