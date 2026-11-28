"use client";

import { useId, useState } from "react";
import { FormAlert } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SELECT_CLASS } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { assignCashier, unassignCashier, useCashierAssignments, useInvalidateAllocations, type CashierAssignment } from "@/lib/allocations/allocations";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDateTime } from "@/lib/datetime";
import { useLocations, type Location } from "@/lib/inventory/inventory";

// CASHIER TILLS (M4.5 W3): which location each cashier sells from. The backend holds it — a cashier
// opens a shift and rings a sale ONLY at their assigned till — so this screen is where an owner or
// manager puts a cashier on a till or moves them. A move takes effect at once: a shift open at the
// old till rings no further sale, and the cashier closes it and opens one at the new till.

function Row({ cashier, places, onDone }: { cashier: CashierAssignment; places: readonly Location[]; onDone: (note: string) => void }) {
  const id = useId();
  const [choice, setChoice] = useState(cashier.location?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidateAllocations();
  const changed = choice !== (cashier.location?.id ?? "");

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (choice === "") {
        await unassignCashier(cashier.userId);
        onDone(`${cashier.fullName} is no longer assigned to a till. They cannot open a shift until you assign them again.`);
      } else {
        const saved = await assignCashier(cashier.userId, choice);
        onDone(
          cashier.location === null
            ? `${cashier.fullName} now sells from ${saved.location?.name ?? "the chosen till"}.`
            : `${cashier.fullName} moved to ${saved.location?.name ?? "the chosen till"}. If they have a shift open at ${cashier.location.name}, they close it and open a new one there before their next sale.`,
        );
      }
      await invalidate();
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "That could not be saved. Check your connection and try again — nothing changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-48">
          <p className="font-medium">{cashier.fullName}</p>
          <p className="text-muted-foreground">{cashier.email}</p>
          <p className="text-muted-foreground">
            {cashier.location ? `Sells from ${cashier.location.name}${cashier.assignedAt ? ` since ${formatDateTime(cashier.assignedAt)}` : ""}` : "Not assigned — cannot open a shift"}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={id}>Till for {cashier.fullName}</Label>
            <select id={id} className={SELECT_CLASS} value={choice} onChange={(event) => setChoice(event.target.value)}>
              <option value="">Not assigned</option>
              {places.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
            </select>
          </div>
          <Button type="button" className="h-11" disabled={!changed || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {error ? <FormAlert id={`${id}-error`}>{error}</FormAlert> : null}
    </li>
  );
}

export function TillsView() {
  const tills = useCashierAssignments();
  const locations = useLocations();
  const [notice, setNotice] = useState<string | null>(null);
  // Any active location but a storefront: a one-till shop sells from MAIN.
  const places = (locations.data?.data ?? []).filter((place) => place.isActive && place.type !== "ECOMMERCE");

  if (tills.isPending || locations.isPending) return <LoadingState label="Loading cashiers and tills" />;
  if (tills.isError) return <ErrorState title="Couldn’t load your cashiers" description={tills.error.message} onRetry={() => void tills.refetch()} />;
  if (locations.isError) return <ErrorState title="Couldn’t load your locations" description={locations.error.message} onRetry={() => void locations.refetch()} />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Each cashier sells only from the till you assign here — they cannot choose another. Owners and managers may sell from any location.
      </p>
      {notice ? <Done>{notice}</Done> : null}
      {tills.data.data.length === 0 ? (
        <EmptyState title="No cashiers yet" description="Invite a cashier from People & access, then assign them a till here." />
      ) : (
        <ul aria-label="Cashiers" className="space-y-2">
          {tills.data.data.map((cashier) => (
            <Row key={`${cashier.userId}-${cashier.location?.id ?? "none"}`} cashier={cashier} places={places} onDone={setNotice} />
          ))}
        </ul>
      )}
    </div>
  );
}
