"use client";

import { useQueryClient } from "@tanstack/react-query";
import { MapPin, PackagePlus } from "lucide-react";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useWorkingLocation } from "@/components/shell/location";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import type { Role } from "@/lib/auth/landing";
import { formatTime } from "@/lib/datetime";
import { useMyLocation } from "@/lib/allocations/allocations";
import { readSelectedLocation } from "@/lib/location/selection";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatKES, parseCents } from "@/lib/money";
import { createSale } from "@/lib/pos/api";
import { cartReducer, cartToLines, type CartProduct } from "@/lib/pos/cart";
import { posKeys, useCurrentShift, useQuote, useShiftSummary } from "@/lib/pos/hooks";
import { cashierMessage, isTenderMismatch } from "@/lib/pos/messages";
import { evaluateTenders, holdsMpesaMoney, markStale, newTender, tendersToBody, typedCents, type TenderLine } from "@/lib/pos/tender";
import type { Customer, ShiftSummary } from "@/lib/pos/types";
import { CartView, overSellable, Totals } from "./cart-view";
import { CloseShift } from "./close-shift";
import { CustomerPicker } from "./customer-picker";
import { CustomerTotal } from "./customer-total";
import { OpenShift } from "./open-shift";
import { ProductSearch } from "./product-search";
import { ReceiptView } from "./receipt-view";
import { ShiftSales } from "./shift-sales";
import { StockRequests } from "./stock-requests";
import { TenderPanel } from "./tender-panel";
import { Greeting } from "@/components/shell/greeting";

// THE TILL. Three gates before anything sells:
//   1. a SELLING LOCATION — the sale draws that location's own stock, so the till never silently
//      sells from MAIN. A CASHIER sells from the ONE till an owner or manager assigned them (M4.5
//      W3 — the backend refuses anything else), shown as context and never offered as a choice; an
//      owner or manager picks a working location, and with none chosen the till asks for one;
//   2. an OPEN SHIFT — opened with the counted float;
//   3. a VALID QUOTE — the server prices the cart (VAT included), and that total is what payment
//      is taken against.
// Then SELL -> PAY -> DONE: the cart, the tenders against the quote's total, and the receipt. A
// refused charge keeps the cart and the tenders exactly as they were.
// While payment is being taken the CART IS LOCKED: editing it means clearing the payments, and an
// M-Pesa payment already received (or still being answered) cannot be cleared at all — the sale is
// completed, and undoing money received is a refund, not an edit.

const OWNER_OR_MANAGER: readonly Role[] = ["MSME_OWNER", "MSME_MANAGER"];

/**
 * Whether the cashier CHOSE this location. The shell falls back to the default (MAIN) when nothing
 * was ever picked; the till does not sell on that fallback, because selling from the wrong
 * location's stock is how a till is refused or the wrong shelf is debited.
 */
function chosen(locationId: string): boolean {
  return typeof document !== "undefined" && readSelectedLocation(document.cookie) === locationId;
}

/** Where the till sells from: an id and a name is all it needs. */
interface Place {
  id: string;
  name: string;
}

function ShiftBar({ shift, place, children }: { shift: ShiftSummary; place: Place; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm">
      <p>
        <span className="inline-flex items-center gap-1 font-medium">
          <MapPin className="size-4" aria-hidden /> {place.name}
        </span>{" "}
        · <span className="font-medium">Shift open</span> since {formatTime(shift.openedAt)} · {shift.saleCount.toString()} {shift.saleCount === 1 ? "sale" : "sales"} · KES{" "}
        {formatKES(shift.gross)}
      </p>
      {children}
    </div>
  );
}

function LeaveConfirm({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    stay.current?.focus();
  }, []);
  return (
    <div role="alertdialog" aria-labelledby="pos-leave-title" aria-describedby="pos-leave-body" className="space-y-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
      <p id="pos-leave-title" className="font-medium">
        Edit the cart?
      </p>
      <p id="pos-leave-body" className="text-sm">
        The payments entered so far will be cleared, and you take payment again for the new total.
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button ref={stay} type="button" variant="outline" className="h-11" onClick={onStay}>
          Stay on payment
        </Button>
        <Button type="button" className="h-11" onClick={onLeave}>
          Clear payments and edit the cart
        </Button>
      </div>
    </div>
  );
}

export interface TillProps {
  role: Role;
}

type Phase = { step: "sell" } | { step: "pay" } | { step: "done"; saleId: string };

export function Till({ role }: TillProps) {
  const client = useQueryClient();
  const location = useWorkingLocation();
  const cashier = role === "CASHIER";
  const mine = useMyLocation(cashier);
  const chosenPlace = location?.selected && chosen(location.selected.id) ? location.selected : null;
  const selected: Place | null = cashier ? (mine.data?.location ?? null) : chosenPlace;
  const shift = useCurrentShift(selected !== null);
  const [stockSheet, setStockSheet] = useState(false);
  const summary = useShiftSummary(shift.data?.id ?? null);
  const [lines, dispatch] = useReducer(cartReducer, []);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: "sell" });
  const [tenders, setTenders] = useState<TenderLine[]>([]);
  const [charging, setCharging] = useState(false);
  const [chargeError, setChargeError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  /** The total the tenders were taken against, and what to say once it moves. */
  const [paidAgainst, setPaidAgainst] = useState<bigint | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<"confirm" | "blocked" | null>(null);
  const [showSales, setShowSales] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  const quoteLines = cartToLines(lines);
  const quote = useQuote(
    quoteLines !== null && selected !== null
      ? { lines: quoteLines, sellingLocationId: selected.id, ...(customer ? { customerId: customer.id } : {}) }
      : null,
  );
  const quoteError = quote.isError ? quote.error.message : null;

  const add = (product: CartProduct) => {
    dispatch({ type: "add", product });
    search.current?.focus();
  };

  // Payment is taken only against a quote that answers exactly the cart on screen.
  const priced = lines.length > 0 && quote.isCurrent;
  const total = lines.length > 0 && quote.data ? parseCents(quote.data.total) : 0n;
  const canPay = priced && total > 0n && !overSellable(lines, quote.data);

  // The total moved under the payment (a new customer, or a stale-total refusal re-asked the
  // quote): an M-Pesa prompt not yet answered for must not go out for the old figure.
  if (phase.step === "pay" && priced && paidAgainst !== null && total !== paidAgainst) {
    setPaidAgainst(total);
    setTenders(markStale(tenders));
    setNotice(`The total changed to KES ${formatKES(total)}. Check the payments before charging.`);
  }

  function startPayment() {
    setChargeError(null);
    if (tenders.length === 0) setTenders([newTender("CASH", total)]);
    setPaidAgainst(total);
    setNotice(null);
    setPhase({ step: "pay" });
  }

  function backToCart() {
    setTenders([]);
    setChargeError(null);
    setPaidAgainst(null);
    setNotice(null);
    setLeaving(null);
    setPhase({ step: "sell" });
    requestAnimationFrame(() => search.current?.focus());
  }

  function requestBack() {
    setChargeError(null);
    if (tenders.some(holdsMpesaMoney)) setLeaving("blocked");
    else if (tenders.length === 0) backToCart();
    else setLeaving("confirm");
  }

  function reset() {
    dispatch({ type: "clear" });
    setCustomer(null);
    setTenders([]);
    setChargeError(null);
    setPaidAgainst(null);
    setNotice(null);
    setLeaving(null);
    setPhase({ step: "sell" });
    requestAnimationFrame(() => search.current?.focus());
  }

  async function charge() {
    if (!shift.data || !selected || quoteLines === null) return;
    setCharging(true);
    setChargeError(null);
    try {
      const sale = await createSale({
        shiftId: shift.data.id,
        sellingLocationId: selected.id,
        ...(customer ? { customerId: customer.id } : {}),
        lines: quoteLines,
        tenders: tendersToBody(tenders),
      });
      void client.invalidateQueries({ queryKey: posKeys.currentShift() });
      void client.invalidateQueries({ queryKey: posKeys.shiftSummary(shift.data.id) });
      void client.invalidateQueries({ queryKey: posKeys.customers() });
      setPhase({ step: "done", saleId: sale.id });
    } catch (failure) {
      // A server fault after "Charge" may or may not have recorded the sale: the cashier checks the
      // shift's sales before charging again, so a customer is never charged twice.
      const message =
        failure instanceof ApiHttpError && failure.status >= 500
          ? "The sale may or may not have gone through. Open “Sales this shift” to check before charging again — the cart and payments are kept."
          : failure instanceof ApiHttpError
            ? failure.message
            : "The sale could not be completed. Nothing was charged — check the connection and try again.";
      // The total the payment was taken against is stale: re-price, and say so.
      if (failure instanceof ApiHttpError && failure.status === 400 && isTenderMismatch(message)) void quote.refetch();
      setChargeError(cashierMessage(message));
    } finally {
      setCharging(false);
    }
  }

  // A cashier moved to another till since opening this shift: the server will ring no sale on it.
  const moved = cashier && selected !== null && shift.data != null && shift.data.locationId !== null && shift.data.locationId !== selected.id;

  let body: ReactNode;
  if (cashier && mine.isPending) {
    body = <LoadingState label="Finding your till" />;
  } else if (cashier && mine.isError) {
    body = <ErrorState title="Couldn’t find your till" description={mine.error.message} onRetry={() => void mine.refetch()} />;
  } else if (cashier && selected === null) {
    body = (
      <EmptyState
        icon={MapPin}
        title="You are not assigned to a till yet"
        description="Each cashier sells from the till their manager assigns. Ask your manager to assign you, then check again — nothing has been sold or changed."
        action={
          <Button type="button" variant="outline" className="h-11" onClick={() => void mine.refetch()}>
            Check again
          </Button>
        }
      />
    );
  } else if (!cashier && (!location || location.status === "loading")) {
    body = <LoadingState label="Loading your locations" />;
  } else if (!cashier && location?.status === "error") {
    body = <ErrorState title="Couldn’t load your locations" description="The till sells from a location's own stock, so it needs to know where you are." onRetry={location.retry} />;
  } else if (!selected) {
    body = (
      <EmptyState
        icon={MapPin}
        title="Choose the location you are selling from"
        description="Each location sells only the stock it holds. Pick yours to open the till."
        action={
          location && location.locations.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-2">
              {location.locations.map((place) => (
                <Button key={place.id} type="button" variant="outline" className="h-11" onClick={() => location.select(place.id)}>
                  Sell from {place.name}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      />
    );
  } else if (shift.isPending) {
    body = <LoadingState label="Checking your shift" />;
  } else if (shift.isError) {
    body = <ErrorState title="Couldn’t check your shift" description={shift.error.message} onRetry={() => void shift.refetch()} />;
  } else if (shift.data === null) {
    body = <OpenShift locationName={selected.name} locationId={cashier ? undefined : selected.id} />;
  } else {
    const current = summary.data ?? shift.data;
    const pricing = quoteLines !== null && (quote.isFetching || quote.data === undefined);
    const holding = tenders.some(holdsMpesaMoney);
    const received = tenders.filter((line) => line.mpesa?.mode === "stk" && line.mpesa.stage === "confirmed").reduce((sum, line) => sum + (typedCents(line.amount) ?? 0n), 0n);
    const outstanding = phase.step === "pay" ? evaluateTenders(tenders, total, customer).outstanding : null;
    body = (
      <div className="space-y-4">
        <div className="no-print">
          <ShiftBar shift={current} place={selected}>
            {phase.step !== "done" ? (
              <div className="flex flex-wrap gap-2">
                {cashier ? (
                  <Button type="button" variant="outline" className="h-11" onClick={() => setStockSheet(true)}>
                    <PackagePlus aria-hidden /> Stock & requests
                  </Button>
                ) : null}
                <Button type="button" variant="outline" className="h-11" onClick={() => setShowSales(true)}>
                  Sales this shift
                </Button>
                <Button type="button" variant="outline" className="h-11" onClick={() => setClosing(true)} disabled={charging || holding}>
                  Close shift
                </Button>
              </div>
            ) : null}
          </ShiftBar>
        </div>
        {moved ? (
          <div role="alert" className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
            <p className="font-medium">You have been moved to {selected.name}.</p>
            <p>This shift was opened at your previous till, so it can ring no more sales. Close it (count the drawer as usual), then open a new shift here.</p>
          </div>
        ) : null}
        {phase.step === "done" ? (
          <ReceiptView saleId={phase.saleId} onNewSale={reset} role={role} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
            <div className="min-w-0 space-y-4">
              {phase.step === "sell" ? (
                <>
                  <ProductSearch ref={search} onAdd={add} />
                  <CartView lines={lines} quote={quote.data} locationName={selected.name} dispatch={dispatch} />
                </>
              ) : (
                <>
                  {leaving === "blocked" ? (
                    <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
                      <p className="font-medium text-destructive">
                        {received > 0n
                          ? `KES ${formatKES(received)} has been received by M-Pesa for this basket, so the cart cannot change now.`
                          : "The customer is still answering an M-Pesa prompt, so the cart cannot change now."}
                      </p>
                      <p>Complete the sale. Undoing a payment the customer has made is a refund, not an edit.</p>
                      <Button type="button" variant="outline" className="h-11" onClick={() => setLeaving(null)}>
                        OK
                      </Button>
                    </div>
                  ) : null}
                  {leaving === "confirm" ? <LeaveConfirm onStay={() => setLeaving(null)} onLeave={backToCart} /> : null}
                  <TenderPanel
                    total={total}
                    tenders={tenders}
                    customer={customer}
                    onChange={setTenders}
                    onCharge={() => void charge()}
                    onBack={requestBack}
                    charging={charging}
                    repricing={!priced}
                    error={chargeError}
                    notice={notice}
                  />
                </>
              )}
            </div>
            <aside className="min-w-0 space-y-4">
              {lines.length > 0 ? <CustomerTotal total={priced || phase.step === "pay" ? total : null} outstanding={outstanding} /> : null}
              <CustomerPicker customer={customer} onChange={setCustomer} canSetCredit={OWNER_OR_MANAGER.includes(role)} />
              <Totals quote={lines.length > 0 ? quote.data : undefined} updating={pricing} error={quoteError} />
              {overSellable(lines, quote.data) ? (
                <div role="alert" className="space-y-2 text-sm text-destructive">
                  <p>
                    A line asks for more than {selected.name} holds. Lower the quantity{cashier ? ", or ask your manager for more stock." : ", or move stock here first."}
                  </p>
                  {cashier ? (
                    <Button type="button" variant="outline" className="h-11" onClick={() => setStockSheet(true)}>
                      <PackagePlus aria-hidden /> Request more stock
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {phase.step === "sell" ? (
                <Button type="button" className="h-12 w-full text-base" disabled={!canPay || moved} onClick={startPayment}>
                  {priced ? `Take payment · KES ${formatKES(total)}` : "Take payment"}
                </Button>
              ) : null}
            </aside>
          </div>
        )}
        {stockSheet ? <StockRequests onClose={() => setStockSheet(false)} /> : null}
        {showSales ? <ShiftSales shiftId={current.id} role={role} onClose={() => setShowSales(false)} /> : null}
        {closing ? (
          <CloseShift
            shift={current}
            saleInProgress={lines.length > 0 && phase.step !== "done"}
            onClose={(closedShift) => {
              setClosing(false);
              if (closedShift) reset();
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-baseline justify-between gap-2">
        <Greeting />
        <h1 className="font-display text-2xl font-semibold">Point of sale</h1>
        {selected ? <p className="text-sm text-muted-foreground">Selling from {selected.name}</p> : null}
      </div>
      {body}
    </div>
  );
}
