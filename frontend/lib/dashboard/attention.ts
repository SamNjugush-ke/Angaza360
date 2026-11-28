import type { Role } from "@/lib/auth/landing";
import { formatKES, parseCents } from "@/lib/money";
import { decideAccess } from "@/lib/nav/access";
import { isAbsent, isNotPermitted, type Absent, type Gated } from "./fetch";
import type { DashboardSummary, EtimsBacklog, EtimsDevice, OpenReceivables, VatReturn } from "./types";

// What needs the owner's attention — derived from the live sources, never invented. A card appears
// only when its source is LOADED, the role may READ it (a 403 source is simply absent), and there
// is actually something to act on. Actions appear only for roles that can act (owner, manager)
// AND whose route guard admits the destination — so a button never leads to a refusal.

/** Roles that act on the business from the dashboard (record sales, reorder, file). */
export const ACTING_ROLES: readonly Role[] = ["MSME_OWNER", "MSME_MANAGER"];

export function canAct(role: Role): boolean {
  return ACTING_ROLES.includes(role);
}

export interface Action {
  label: string;
  href: string;
}

/** An action, if this role may act and may open its destination. */
export function actionFor(role: Role, label: string, href: string): Action | undefined {
  return canAct(role) && decideAccess(role, href).allowed ? { label, href } : undefined;
}

export type AttentionKey = "overdue-receivables" | "low-stock" | "tax" | "etims";

export interface AttentionItem {
  key: AttentionKey;
  title: string;
  /** The headline figure, already formatted. */
  figure: string;
  detail: string;
  action?: Action;
}

export interface AttentionSources {
  openReceivables: Gated<OpenReceivables> | undefined;
  dashboard: Gated<DashboardSummary> | undefined;
  /** The return for the current statutory month (this calendar month to date). */
  vatReturn: Gated<VatReturn> | undefined;
  /** "June 2026" — the statutory month the return covers. */
  statutoryMonth: string;
  etimsDevice: Gated<EtimsDevice> | Absent | undefined;
  etimsBacklog: Gated<EtimsBacklog> | undefined;
}

function loaded<T>(value: Gated<T> | Absent | undefined): T | undefined {
  return value === undefined || isNotPermitted(value) || isAbsent(value) ? undefined : value;
}

const plural = (n: number, one: string, many: string) => `${n.toString()} ${n === 1 ? one : many}`;

export function buildAttention(role: Role, sources: AttentionSources): AttentionItem[] {
  const items: AttentionItem[] = [];

  const open = loaded(sources.openReceivables);
  if (open !== undefined) {
    // Aged by sale date: day 0 is current, every older day is overdue (the AR aging rule).
    const overdue = open.data.filter((sale) => sale.daysOutstanding >= 1);
    if (overdue.length > 0) {
      const amount = overdue.reduce((total, sale) => total + parseCents(sale.outstanding), 0n);
      const customers = new Set(overdue.map((sale) => sale.customerId)).size;
      items.push({
        key: "overdue-receivables",
        title: "Overdue receivables",
        figure: formatKES(amount, { currency: true }),
        detail: `${plural(overdue.length, "invoice", "invoices")} from ${plural(customers, "customer", "customers")}`,
        action: actionFor(role, `Review ${plural(overdue.length, "invoice", "invoices")}`, "/customers"),
      });
    }
  }

  const dashboard = loaded(sources.dashboard);
  if (dashboard !== undefined && dashboard.lowStockCount > 0) {
    items.push({
      key: "low-stock",
      title: "Low stock",
      figure: plural(dashboard.lowStockCount, "item", "items"),
      detail: "At or below the reorder level",
      action: actionFor(role, "Reorder", "/inventory"),
    });
  }

  const vat = loaded(sources.vatReturn);
  if (vat !== undefined) {
    if (vat.presentation === "VAT_RETURN" && vat.vat.position === "PAYABLE" && parseCents(vat.vat.netVat) > 0n) {
      items.push({
        key: "tax",
        title: "VAT payable",
        figure: formatKES(vat.vat.netVat, { currency: true }),
        detail: `For ${sources.statutoryMonth} so far`,
        action: actionFor(role, "Open VAT return", "/tax"),
      });
    } else if (vat.presentation === "TOT_POSITION" && parseCents(vat.turnoverTax.accrued) > 0n) {
      items.push({
        key: "tax",
        title: "Turnover Tax",
        figure: formatKES(vat.turnoverTax.accrued, { currency: true }),
        detail: `Accrued for ${sources.statutoryMonth} so far`,
        action: actionFor(role, "Open tax return", "/tax"),
      });
    }
  }

  const device = loaded(sources.etimsDevice);
  const backlog = loaded(sources.etimsBacklog);
  if (device !== undefined && backlog !== undefined) {
    const waiting = backlog.queued + backlog.failed;
    if (waiting > 0) {
      items.push({
        key: "etims",
        title: "eTIMS invoices to file",
        figure: plural(waiting, "invoice", "invoices"),
        detail: backlog.failed > 0 ? `${backlog.failed.toString()} need attention` : "Waiting to be sent to KRA",
        action: actionFor(role, "File now", "/tax"),
      });
    }
  }

  return items;
}
