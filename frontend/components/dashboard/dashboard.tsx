"use client";

import { LoadingState } from "@/components/states/states";
import type { Role } from "@/lib/auth/landing";
import { buildAttention, canAct } from "@/lib/dashboard/attention";
import { isAbsent, isNotPermitted } from "@/lib/dashboard/fetch";
import {
  useCustomers,
  useDashboard,
  useDashboardDeltas,
  useEtimsBacklog,
  useEtimsStatus,
  useOpenReceivables,
  useReadiness,
  useRecentSales,
  useTopProducts,
  useTrend,
  useVatReturn,
} from "@/lib/dashboard/hooks";
import { decideAccess } from "@/lib/nav/access";
import { usePeriod } from "@/lib/dashboard/period";
import { compactPeriod, periodKindOf } from "@/lib/dashboard/periods";
import { showReadiness } from "@/lib/dashboard/readiness";
import { monthToDate } from "@/lib/datetime";
import { AttentionStrip } from "./attention-strip";
import { DashboardHeader } from "./dashboard-header";
import { MoneyOverview } from "./money-overview";
import { Panel } from "./panel";
import { PositionBody, TopExpensesBody } from "./position-panels";
import { RecentSalesBody } from "./recent-sales";
import { TopProductsBody } from "./top-products";
import { ReadinessCanvas } from "./readiness-canvas";
import { monthLongLabel, TrendChart } from "./trend-chart";

// The merchant dashboard. Owners and managers of a business that is not trading yet see the
// readiness canvas; everyone else (and a trading business) sees the operational dashboard. Every
// panel reads its own source and owns its states; a source the role cannot read hides its panel.

export interface DashboardProps {
  role: Role;
  fullName: string;
  businessName: string;
}

export function Dashboard({ role, fullName, businessName }: DashboardProps) {
  const acting = canAct(role);
  const readiness = useReadiness(acting);

  if (acting && readiness.isLoading) {
    return (
      <div className="space-y-6">
        <DashboardHeader fullName={fullName} businessName={businessName} showPeriod={false} />
        <LoadingState label="Loading your dashboard" lines={6} />
      </div>
    );
  }
  const ready = readiness.data;
  if (acting && ready !== undefined && !isNotPermitted(ready) && showReadiness(ready)) {
    return (
      <div className="space-y-6">
        <DashboardHeader fullName={fullName} businessName={businessName} showPeriod={false} />
        <ReadinessCanvas role={role} readiness={ready} />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <DashboardHeader fullName={fullName} businessName={businessName} showPeriod />
      <Operational role={role} />
    </div>
  );
}

function Operational({ role }: { role: Role }) {
  const { period } = usePeriod();
  const summary = useDashboard(period);
  const deltas = useDashboardDeltas(period, periodKindOf(period));
  const trend = useTrend(6);
  const top = useTopProducts(period, { limit: 5, by: "revenue" });
  const recent = useRecentSales(6);
  const customers = useCustomers();

  // Attention looks at NOW: open receivables, this calendar month's tax, the eTIMS backlog.
  const open = useOpenReceivables();
  const statutory = monthToDate();
  const vat = useVatReturn(statutory);
  const device = useEtimsStatus();
  const deviceReady = device.data !== undefined && !isNotPermitted(device.data) && !isAbsent(device.data) && device.data.initialized;
  const backlog = useEtimsBacklog(deviceReady);
  const attention = buildAttention(role, {
    openReceivables: open.data,
    dashboard: summary.data,
    vatReturn: vat.data,
    statutoryMonth: monthLongLabel(statutory.from.slice(0, 7)),
    etimsDevice: device.data,
    etimsBacklog: backlog.data,
  });
  const attentionLoading = open.isLoading || summary.isLoading || vat.isLoading || device.isLoading;
  const comparedWith = { label: deltas.comparedWith, range: compactPeriod(deltas.baseline) };
  const delta = deltas.deltas !== undefined && !isNotPermitted(deltas.deltas) ? deltas.deltas : undefined;
  /** A drill-through, only where this role's route guard admits it. */
  const link = (href: string, label: string) => (decideAccess(role, href).allowed ? { href, label } : undefined);

  // DOM order is the mobile priority (attention → headline figures → trend → what's selling →
  // latest sales → position → expenses); xl:order arranges the desktop grid.
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-12">
      <div className="min-w-0 md:col-span-2 xl:order-first xl:col-span-12">
        <AttentionStrip items={attention} loading={attentionLoading} />
      </div>
      <Panel title="Money overview" what="your figures for this period" query={summary} className="md:col-span-2 xl:order-1 xl:col-span-5" skeletonLines={4}>
        {(data) => <MoneyOverview role={role} summary={data} deltas={delta} comparedWith={comparedWith} />}
      </Panel>
      <Panel title="Last 6 months" what="your sales trend" query={trend} className="md:col-span-2 xl:order-2 xl:col-span-7" skeletonLines={6}>
        {(buckets) => <TrendChart buckets={buckets} />}
      </Panel>
      <Panel title="Top products" what="your top products" query={top} link={link("/products", "All products")} className="xl:order-4 xl:col-span-4" skeletonLines={5}>
        {(products) => <TopProductsBody products={products} />}
      </Panel>
      <Panel title="Latest sales" what="your latest sales" query={recent} link={link("/sales", "All sales")} className="md:col-span-2 xl:order-6 xl:col-span-12" skeletonLines={5}>
        {(sales) => <RecentSalesBody role={role} sales={sales} customers={customers.data} showFiscal={deviceReady} />}
      </Panel>
      <Panel title="Cash and balances" what="your cash position" query={summary} className="xl:order-3 xl:col-span-4" skeletonLines={5}>
        {(data) => <PositionBody role={role} summary={data} />}
      </Panel>
      <Panel title="Top expenses" what="your expenses" query={summary} className="xl:order-5 xl:col-span-4" skeletonLines={4}>
        {(data) => <TopExpensesBody summary={data} />}
      </Panel>
    </div>
  );
}
