import type { Metadata } from "next";
import { Exports } from "@/components/exports/exports";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Reporting center" };

async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // The platform report library (/v1/platform-reports): the server lists only the reports this role
  // may run. ?report=<id>&<filter>=<value> opens one already filtered (the tenant explorer's export link).
  await requireSession();
  const params = await searchParams;
  const report = typeof params.report === "string" ? params.report : undefined;
  const filters = Object.fromEntries(Object.entries(params).filter((e): e is [string, string] => e[0] !== "report" && typeof e[1] === "string"));
  return <Exports library="platform" initialReport={report} initialFilters={filters} />;
}

export default guarded(ReportsPage);
