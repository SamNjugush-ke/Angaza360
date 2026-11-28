"use client";

import type { Role } from "@/lib/auth/landing";
import type { DashboardSummary } from "@/lib/dashboard/types";
import { formatKES, parseCents } from "@/lib/money";
import { decideAccess } from "@/lib/nav/access";
import { PanelLink } from "./panel";

// Where the money is: cash (with its ledger accounts), what customers owe the business and what
// it owes its suppliers — as at the end of the period. These are LEDGER balances (what the books
// say), not a live bank or M-Pesa feed, and they are labelled so.

function viewLink(role: Role, href: string, label: string) {
  return decideAccess(role, href).allowed ? <PanelLink href={href}>{label}</PanelLink> : null;
}

export function PositionBody({ role, summary }: { role: Role; summary: DashboardSummary }) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted-foreground">Cash position</p>
        <p className="tabular font-display text-2xl font-semibold">{formatKES(summary.cashPosition.total, { currency: true })}</p>
        <ul className="mt-2 space-y-1 text-sm" aria-label="Cash by ledger account">
          {summary.cashPosition.accounts.map((account) => (
            <li key={account.code} className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{account.name}</span>
              <span className="tabular">{formatKES(account.amount)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-muted-foreground">Ledger balances, as recorded in your books</p>
      </div>
      <div className="grid grid-cols-2 gap-4 border-t pt-4">
        <div>
          <p className="text-sm text-muted-foreground">You’re owed</p>
          <p className="tabular text-lg font-semibold">{formatKES(summary.receivables, { currency: true })}</p>
          {viewLink(role, "/customers", "Customers")}
        </div>
        <div>
          <p className="text-sm text-muted-foreground">You owe</p>
          <p className="tabular text-lg font-semibold">{formatKES(summary.payables, { currency: true })}</p>
          {viewLink(role, "/expenses", "Payables")}
        </div>
      </div>
    </div>
  );
}

/** A share of a total as a whole percentage, in BigInt — a bar width, not money. */
export function shareOf(part: bigint, total: bigint): bigint {
  if (total <= 0n || part <= 0n) return 0n;
  return (part * 100n + total / 2n) / total;
}

export function TopExpensesBody({ summary }: { summary: DashboardSummary }) {
  const categories = summary.topExpenseCategories;
  if (categories.length === 0) return <p className="text-sm text-muted-foreground">No expenses in this period.</p>;
  const total = categories.reduce((sum, c) => sum + parseCents(c.amount), 0n);
  const largest = categories.reduce((max, c) => (parseCents(c.amount) > max ? parseCents(c.amount) : max), 0n);
  return (
    <ul className="space-y-3">
      {categories.map((category) => {
        const amount = parseCents(category.amount);
        return (
          <li key={category.code} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0">{category.name}</span>
              <span className="tabular shrink-0 whitespace-nowrap font-medium">
                {formatKES(amount)} <span className="font-normal text-muted-foreground">· {shareOf(amount, total).toString()}%</span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted" aria-hidden>
              <div className="h-2 rounded-full bg-primary" style={{ width: `${shareOf(amount, largest).toString()}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
