import { KIND_LABEL, type ProductKind } from "@/lib/catalog/types";
import { cn } from "@/lib/utils";

// The catalog's two badges. Text carries the meaning; colour only reinforces it.

const BADGE = "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium";

export function KindBadge({ kind }: { kind: ProductKind }) {
  return <span className={cn(BADGE, kind === "SERVICE" ? "border-primary/40 bg-primary/10 text-foreground" : "bg-muted text-foreground")}>{KIND_LABEL[kind]}</span>;
}

export function StatusBadge({ active }: { active: boolean }) {
  return (
    <span className={cn(BADGE, active ? "border-emerald-700/40 bg-emerald-700/10 text-foreground" : "border-destructive/40 bg-destructive/10 text-foreground")}>
      {active ? "Active" : "Inactive"}
    </span>
  );
}
