import { tenderName } from "@/lib/sales/sales";
import type { SaleRecord } from "@/lib/pos/types";
import { cn } from "@/lib/utils";

// Sales badges. Text carries the meaning; colour only reinforces it.

const BADGE = "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium";

export function SaleStatusBadge({ status }: { status: SaleRecord["status"] }) {
  return (
    <span className={cn(BADGE, status === "VOIDED" ? "border-destructive/40 bg-destructive/10 text-foreground" : "border-emerald-700/40 bg-emerald-700/10 text-foreground")}>
      {status === "VOIDED" ? "Voided" : "Completed"}
    </span>
  );
}

/** One badge per tender kind, e.g. "Cash", "M-Pesa · Till" (repeats collapse). */
export function TenderBadges({ tenders }: { tenders: ReadonlyArray<Pick<SaleRecord["tenders"][number], "tenderType" | "mpesaChannel">> }) {
  const names = [...new Set(tenders.map(tenderName))];
  return (
    <span className="flex flex-wrap gap-1">
      {names.map((name) => (
        <span key={name} className={cn(BADGE, name.startsWith("M-Pesa") ? "border-primary/40 bg-primary/10 text-foreground" : "bg-muted text-foreground")}>
          {name}
        </span>
      ))}
    </span>
  );
}
