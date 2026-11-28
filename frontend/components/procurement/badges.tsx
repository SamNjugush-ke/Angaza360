import { STATUS_LABEL, type PurchaseOrderStatus } from "@/lib/procurement/procurement";
import { cn } from "@/lib/utils";

// A purchase order's status. Text carries the meaning; colour only reinforces it.

const TONE: Readonly<Record<PurchaseOrderStatus, string>> = {
  DRAFT: "bg-muted",
  APPROVED: "border-primary/40 bg-primary/10",
  PARTIALLY_RECEIVED: "border-amber-500/50 bg-amber-500/10",
  RECEIVED: "border-emerald-700/40 bg-emerald-700/10",
  CLOSED: "bg-muted",
  CANCELLED: "border-destructive/40 bg-destructive/10",
};

export function StatusBadge({ status }: { status: PurchaseOrderStatus }) {
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium text-foreground", TONE[status])}>{STATUS_LABEL[status]}</span>;
}
