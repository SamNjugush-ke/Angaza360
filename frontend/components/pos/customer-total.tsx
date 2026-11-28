import { formatKES } from "@/lib/money";
import { cn } from "@/lib/utils";

// What the customer reads off the till: the total in large figures — so they can pay it to the
// Till or Paybill number themselves — and, once payment is being taken, what is still to pay.
// Figures are the server's quote and the tenders the cashier entered; nothing is computed here.

export function CustomerTotal({ total, outstanding }: { total: bigint | null; outstanding: bigint | null }) {
  return (
    <section aria-label="Customer total" className="rounded-lg border-2 border-primary/40 bg-primary/5 px-4 py-3">
      <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Total to pay</p>
      <p className="font-display text-4xl font-bold tabular-nums sm:text-5xl">KES {total === null ? "—" : formatKES(total)}</p>
      {outstanding !== null ? (
        <p className={cn("mt-1 text-2xl font-semibold tabular-nums", outstanding > 0n ? "text-destructive" : "text-foreground")}>
          {outstanding > 0n ? `Still to pay KES ${formatKES(outstanding)}` : outstanding < 0n ? `Over by KES ${formatKES(-outstanding)}` : "Paid in full"}
        </p>
      ) : null}
    </section>
  );
}
