// The operator's way to run a maintenance job (M4.5 W4) — the same runner Cloud Scheduler reaches
// through the protected endpoint, so a CLI run is locked, retried and recorded exactly like a
// scheduled one.
//
// Usage: npm run jobs:run -- <job-name> [--key <idempotency-key>]
//        npm run jobs:run -- --list

import { platformDb } from "../db/platform";
import { closePool } from "../db/pool";
import { disconnectAllTenantDbs } from "../db/tenant";
import { JOBS } from "../services/jobs/jobs";
import { runJob } from "../services/jobs/runner";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--list") || argv.length === 0) {
    for (const job of JOBS) console.log(`${job.name.padEnd(30)} ${job.suggestedSchedule.padEnd(18)} ${job.description}`);
    return;
  }
  const name = argv[0] ?? "";
  const keyIndex = argv.indexOf("--key");
  const key = keyIndex === -1 ? `cli:${new Date().toISOString()}` : (argv[keyIndex + 1] ?? "");
  const run = await runJob(name, "CLI", key);
  console.log(`${run.jobName}: ${run.status} after ${run.attempts.toString()} attempt(s)${run.error ? ` — ${run.error}` : ""}`);
  if (run.summary !== null) console.log(JSON.stringify(run.summary));
  if (run.status === "FAILED") process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error");
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAllTenantDbs();
    await platformDb.$disconnect();
    await closePool();
  });
