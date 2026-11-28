"use client";

import { useId, useState } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, ProductPicker, quantityProblem, SelectField, type PickedProduct } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import {
  decideRequest,
  plainQuantity,
  sendStock,
  STATUS_LABEL,
  useInvalidateAllocations,
  useRequests,
  type AllocationPermissions,
  type AllocationRequest,
  type AllocationStatus,
  type RequestFilter,
} from "@/lib/allocations/allocations";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDateTime } from "@/lib/datetime";
import { useLocations, type Location } from "@/lib/inventory/inventory";

// THE STOCK-REQUEST WORKLIST (M4.5 W3). Cashiers ask for stock from their till; an owner or manager
// approves it as asked, approves a different quantity, or declines. An approval MOVES the stock
// from MAIN into the till as a transfer — nothing is posted to the books (the goods stay the
// business's). If MAIN does not hold enough, nothing moves and the request STAYS pending. Beside
// it, "Send stock" pushes any product to any location directly, so a request can be topped up
// with other products the till needs.

function explain(failure: unknown, fallback: string): string {
  if (!(failure instanceof ApiHttpError)) return fallback;
  if (failure.status === 409) return `${failure.message} Someone may already have decided it — the list has been refreshed.`;
  if (failure.status === 400 && /insufficient|not enough|owns|negative/i.test(failure.message)) {
    return `${failure.message} Nothing moved and the request is still waiting: approve a smaller quantity, or restock MAIN first.`;
  }
  return failure.message;
}

function DecidePanel({ request, onDone }: { request: AllocationRequest; onDone: (note: string, ok: boolean) => void }) {
  const ids = { qty: useId(), form: useId() };
  const [qty, setQty] = useState(plainQuantity(request.requestedQty));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateAllocations();

  async function decide(decision: "APPROVED" | "DECLINED") {
    if (decision === "APPROVED") {
      const bad = quantityProblem(qty);
      if (bad) {
        setProblem(bad);
        return;
      }
    }
    setBusy(true);
    setProblem(null);
    try {
      const edited = decision === "APPROVED" && qty.trim() !== plainQuantity(request.requestedQty);
      const decided = await decideRequest(request.id, decision === "APPROVED" ? (edited ? { decision, approvedQty: qty.trim() } : { decision }) : { decision });
      await invalidate();
      onDone(
        decided.status === "APPROVED"
          ? `Sent ${plainQuantity(decided.approvedQty ?? request.requestedQty)} × ${request.productName} from MAIN to ${request.locationName}. The stock moved; nothing was posted to the books.`
          : `Declined. Nothing moved — the request shows as declined at ${request.locationName}.`,
        true,
      );
    } catch (failure) {
      await invalidate();
      setProblem(explain(failure, "That could not be done. Check your connection and try again — nothing moved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-3 rounded-md border bg-muted/30 p-3" aria-labelledby={ids.form} role="group">
      <p id={ids.form} className="text-sm font-medium">
        Decide this request
      </p>
      {problem ? <FormAlert id={`${ids.form}-error`}>{problem}</FormAlert> : null}
      <TextField
        id={ids.qty}
        label="Quantity to send"
        hint={`Asked for ${plainQuantity(request.requestedQty)}. Change it to send a different amount.`}
        inputMode="decimal"
        autoComplete="off"
        value={qty}
        onChange={(event) => setQty(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="h-11" disabled={busy} onClick={() => void decide("APPROVED")}>
          {busy ? "Working…" : "Approve and send"}
        </Button>
        <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={() => void decide("DECLINED")}>
          Decline
        </Button>
      </div>
    </div>
  );
}

function SendStock({ locations, initialLocationId, onDone, onCancel }: { locations: readonly Location[]; initialLocationId: string; onDone: (note: string) => void; onCancel: () => void }) {
  const ids = { to: useId(), qty: useId(), form: useId() };
  const [product, setProduct] = useState<PickedProduct | null>(null);
  const [to, setTo] = useState(initialLocationId);
  const [qty, setQty] = useState("");
  const [problem, setProblem] = useState<{ product?: string; qty?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateAllocations();

  async function submit() {
    const bad = quantityProblem(qty);
    if (product === null || bad || to === "") {
      setProblem({ ...(product === null ? { product: "Choose a product." } : {}), ...(bad ? { qty: bad } : {}), ...(to === "" ? { form: "Choose where to send it." } : {}) });
      return;
    }
    setBusy(true);
    setProblem({});
    try {
      const result = await sendStock({ productId: product.id, toLocationId: to, quantity: qty.trim() });
      await invalidate();
      onDone(
        `Sent ${plainQuantity(result.quantity)} × ${product.name} from ${result.fromLocationCode} to ${result.toLocationCode}. ${result.fromLocationCode} now holds ${plainQuantity(result.fromQuantityAfter)}, ${result.toLocationCode} holds ${plainQuantity(result.toQuantityAfter)}. Nothing was posted to the books.`,
      );
    } catch (failure) {
      setProblem({ form: failure instanceof ApiHttpError ? failure.message : "The stock could not be sent. Check your connection and try again — nothing moved." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      aria-labelledby={ids.form}
      className="space-y-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 id={ids.form} className="font-medium">
        Send stock to a location
      </h3>
      <p className="text-sm text-muted-foreground">Moves stock out of MAIN directly — no request needed. Use it to add the other products a till needs.</p>
      {problem.form ? <FormAlert id={`${ids.form}-error`}>{problem.form}</FormAlert> : null}
      <ProductPicker value={product} onChange={setProduct} error={problem.product} />
      <SelectField id={ids.to} label="Send to" value={to} onChange={setTo}>
        <option value="">Choose a location</option>
        {locations.map((place) => (
          <option key={place.id} value={place.id}>
            {place.name}
          </option>
        ))}
      </SelectField>
      <TextField id={ids.qty} label="Quantity" inputMode="decimal" autoComplete="off" value={qty} error={problem.qty} onChange={(event) => setQty(event.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="h-11" disabled={busy}>
          {busy ? "Sending…" : "Send stock"}
        </Button>
        <Button type="button" variant="outline" className="h-11" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const STATUSES: readonly AllocationStatus[] = ["PENDING", "APPROVED", "DECLINED", "CANCELLED"];

export function RequestsView({ permissions }: { permissions: AllocationPermissions }) {
  const ids = { status: useId(), location: useId() };
  const [filter, setFilter] = useState<RequestFilter>({ status: "PENDING", locationId: "", productId: "" });
  const [product, setProduct] = useState<PickedProduct | null>(null);
  const requests = useRequests(filter);
  const locations = useLocations();
  const [deciding, setDeciding] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const places = (locations.data?.data ?? []).filter((place) => place.isActive && !place.isDefault);

  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField id={ids.status} label="Status" value={filter.status} onChange={(v) => setFilter((f) => ({ ...f, status: v as AllocationStatus | "" }))}>
          <option value="">Every request</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </SelectField>
        <SelectField id={ids.location} label="Location" value={filter.locationId} onChange={(v) => setFilter((f) => ({ ...f, locationId: v }))}>
          <option value="">Every location</option>
          {places.map((place) => (
            <option key={place.id} value={place.id}>
              {place.name}
            </option>
          ))}
        </SelectField>
        <ProductPicker
          label="Product"
          value={product}
          onChange={(picked) => {
            setProduct(picked);
            setFilter((f) => ({ ...f, productId: picked?.id ?? "" }));
          }}
        />
      </div>
      {permissions.canSendStock ? (
        sending !== null ? (
          <SendStock
            locations={places}
            initialLocationId={sending}
            onCancel={() => setSending(null)}
            onDone={(note) => {
              setSending(null);
              setNotice(note);
            }}
          />
        ) : (
          <Button type="button" variant="outline" className="h-11" onClick={() => { setNotice(null); setSending(""); }}>
            Send stock to a location
          </Button>
        )
      ) : null}
      {requests.isPending ? <LoadingState label="Loading stock requests" /> : null}
      {requests.isError ? <ErrorState title="Couldn’t load stock requests" description={requests.error.message} onRetry={() => void requests.refetch()} /> : null}
      {requests.isSuccess && requests.data.data.length === 0 ? (
        <EmptyState title={filter.status === "PENDING" ? "No requests waiting" : "No requests match"} description="Cashiers ask for stock from their till; their requests appear here." />
      ) : null}
      {requests.isSuccess && requests.data.data.length > 0 ? (
        <ul aria-label="Stock requests" className="space-y-2">
          {requests.data.data.map((request) => (
            <li key={request.id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {plainQuantity(request.requestedQty)} × {request.productName} <span className="font-mono text-xs text-muted-foreground">{request.sku}</span>
                  </p>
                  <p className="text-muted-foreground">
                    For {request.locationName} · {formatDateTime(request.createdAt)}
                  </p>
                  {request.note ? <p className="mt-1">“{request.note}”</p> : null}
                </div>
                <span className="rounded-full border px-2 py-0.5 text-xs">
                  {STATUS_LABEL[request.status]}
                  {request.status === "APPROVED" && request.approvedQty !== null ? ` · ${plainQuantity(request.approvedQty)} sent` : ""}
                </span>
              </div>
              {request.status === "PENDING" && permissions.canDecide ? (
                deciding === request.id ? (
                  <DecidePanel
                    request={request}
                    onDone={(note) => {
                      setDeciding(null);
                      setNotice(note);
                    }}
                  />
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button type="button" variant="outline" className="h-11" onClick={() => { setNotice(null); setDeciding(request.id); }}>
                      Decide
                    </Button>
                    {permissions.canSendStock ? (
                      <Button type="button" variant="ghost" className="h-11" onClick={() => { setNotice(null); setSending(request.locationId); }}>
                        Send other stock to {request.locationName}
                      </Button>
                    ) : null}
                  </div>
                )
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
