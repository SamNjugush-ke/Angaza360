// PAGE-RENDER SMOKE CHECK — run after `npm run build` (npm run smoke; CI runs it).
//
// Starts the PRODUCTION server and requests each public page through it. Unit tests render
// components in jsdom and never cross Next's real server/client boundary, so a page that
// builds and passes every test can still answer 500 at runtime (e.g. a server component
// calling a function exported from a "use client" module). Only a real request catches that.
// Every listed page must answer 200; an unknown invitation token is a page whose client asks
// the backend later, so it is 200 too (or 404 if it were ever made a not-found) — never 500.
// /workspace, without a session, must answer its redirect to sign in (307) — never 500.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.SMOKE_PORT ?? 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGES = [
  ["/", [200]],
  ["/workspace", [307]],
  ["/login", [200]],
  ["/login?reason=welcome", [200]],
  ["/login?reason=expired", [200]],
  ["/login?reason=reset", [200]],
  ["/forgot", [200]],
  ["/signup", [200]],
  ["/application/status", [200]],
  ["/application/edit", [200]],
  ["/setup", [307, 308]],
  ["/privacy", [200]],
  ["/terms", [200]],
  ["/cookies", [200]],
  ["/acceptable-use", [200]],
  ["/contact", [200]],
  ["/billing-policy", [200]],
  ["/data-processing-agreement", [200]],
  ["/subprocessors", [200]],
  ["/security", [200]],
  ["/invite", [200]],
  ["/invite/smoke-dummy-token", [200, 404]],
];

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_ENV: "production" },
});
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk));
server.stderr.on("data", (chunk) => (serverLog += chunk));

async function waitUntilUp() {
  for (let i = 0; i < 120; i += 1) {
    if (server.exitCode !== null) throw new Error(`next start exited (${server.exitCode})`);
    try {
      await fetch(`${BASE}/robots.txt`);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("next start did not come up within 60s");
}

let failures = 0;
try {
  await waitUntilUp();
  for (const [path, allowed] of PAGES) {
    const response = await fetch(`${BASE}${path}`, { redirect: "manual" });
    const ok = allowed.includes(response.status);
    if (!ok) failures += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${response.status} ${path}`);
  }
} catch (error) {
  failures += 1;
  console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  server.kill();
}

if (failures > 0) {
  console.error(`\n${failures} page(s) failed. Server output:\n${serverLog.split("\n").filter((l) => /error|⨯/i.test(l)).slice(0, 10).join("\n")}`);
  process.exit(1);
}
console.log(`\nall ${PAGES.length} pages rendered`);
