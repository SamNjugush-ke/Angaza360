"use client";

import { useId, useState } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, ProductPicker, quantityProblem, type PickedProduct } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import {
  cancelRequest,
  plainQuantity,
  requestStock,
  STATUS_LABEL,
  useInvalidateAllocations,
  useMyLocation,
  type AllocationRequest,
} from "@/lib/allocations/allocations";
import { formatDateTime } from "@/lib/datetime";
import { ApiHttpError } from "@/lib/dashboard/fetch";

// THE TILL'S STOCK SHEET (M4.5 W3): what is running low at the cashier's own till, a request for
// more of any product, and the cashier's requests with where each stands. A request MOVES NOTHING
// — the manager approves it, and only then does stock arrive here.

function RequestForm({
  locationId,
  product,
  suggested,
  onSent,
  onCancel,
}: {
  locationId: string;
  product: PickedProduct | null;
  suggested?: string;
  onSent: (request: AllocationRequest) => void;
  onCancel?: () => void;
}) {
  const ids = { qty: useId(), note: useId(), form: useId() };
  const [picked, setPicked] = useState<PickedProduct | null>(product);
  const [qty, setQty] = useState(suggested ? plainQuantity(suggested) : "");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<{ product?: string; qty?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    const qtyProblem = quantityProblem(qty);
    if (picked === null || qtyProblem !== null) {
      setProblem({ ...(picked === null ? { product: "Choose the product you need." } : {}), ...(qtyProblem ? { qty: qtyProblem } : {}) });
      return;
    }
    setBusy(true);
    setProblem({});
    try {
      const sent = await requestStock({ productId: picked.id, locationId, requestedQty: qty.trim(), ...(note.trim() ? { note: note.trim() } : {}) });
      onSent(sent);
    } catch (failure) {
      setProblem({ form: failure instanceof ApiHttpError ? failure.message : "The request could not be sent. Check your connection and try again — nothing was sent." });
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
        {product ? `Request more ${product.name}` : "Request stock"}
      </h3>
      {problem.form ? <FormAlert id={`${ids.form}-error`}>{problem.form}</FormAlert> : null}
      {product ? null : <ProductPicker value={picked} onChange={setPicked} error={problem.product} />}
      <TextField id={ids.qty} label="How many" inputMode="decimal" autoComplete="off" value={qty} error={problem.qty} onChange={(event) => setQty(event.target.value)} />
      <TextField id={ids.note} label="Note for your manager" optional autoComplete="off" value={note} onChange={(event) => setNote(event.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="h-11" disabled={busy}>
          {busy ? "Sending…" : "Send the request"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="outline" className="h-11" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function StockRequests({ onClose, initialProduct }: { onClose: () => void; initialProduct?: PickedProduct }) {
  const mine = useMyLocation();
  const invalidate = useInvalidateAllocations();
  const [asking, setAsking] = useState<{ product: PickedProduct | null; suggested?: string } | null>(initialProduct ? { product: initialProduct } : null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sent(request: AllocationRequest) {
    setAsking(null);
    setDone(`Asked for ${plainQuantity(request.requestedQty)} × ${request.productName}. Your manager decides; no stock has moved yet — it arrives here when they approve.`);
    await invalidate();
  }

  async function withdraw(request: AllocationRequest) {
    setError(null);
    try {
      await cancelRequest(request.id);
      setDone(`Your request for ${request.productName} is withdrawn. Nothing was moved.`);
      await invalidate();
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The request could not be withdrawn. Please try again.");
      await invalidate();
    }
  }

  let content;
  if (mine.isPending) content = <LoadingState label="Loading your till's stock" />;
  else if (mine.isError) content = <ErrorState title="Couldn’t load your till's stock" description={mine.error.message} onRetry={() => void mine.refetch()} />;
  else if (mine.data.location === null) content = <EmptyState title="You are not assigned to a till" description="Ask your manager to assign you to one. You can request stock for your till once you have one." />;
  else {
    const location = mine.data.location;
    content = (
      <div className="space-y-5">
        {done ? <Done>{done}</Done> : null}
        {error ? <FormAlert id="stock-request-error">{error}</FormAlert> : null}
        {asking ? (
          <RequestForm
            key={asking.product?.id ?? "any"}
            locationId={location.id}
            product={asking.product}
            {...(asking.suggested ? { suggested: asking.suggested } : {})}
            onSent={(request) => void sent(request)}
            onCancel={() => setAsking(null)}
          />
        ) : (
          <Button type="button" variant="outline" className="h-11" onClick={() => { setDone(null); setAsking({ product: null }); }}>
            Request any product
          </Button>
        )}
        <section aria-labelledby="till-low" className="space-y-2">
          <h3 id="till-low" className="font-medium">
            Running low at {location.name}
          </h3>
          {mine.data.lowStock.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing here is at or below its reorder level.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {mine.data.lowStock.map((slice) => (
                <li key={slice.productId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{slice.productName}</span>
                    <span className="block text-muted-foreground">
                      {plainQuantity(slice.quantity)} left · reorder at {plainQuantity(slice.threshold)}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    onClick={() => {
                      setDone(null);
                      setAsking({ product: { id: slice.productId, name: slice.productName, sku: slice.sku, unitOfMeasure: "", costPrice: "0" }, suggested: slice.suggestedTransferQty });
                    }}
                  >
                    Request more
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="till-requests" className="space-y-2">
          <h3 id="till-requests" className="font-medium">
            Your requests
          </h3>
          {mine.data.myRequests.length === 0 ? (
            <p className="text-sm text-muted-foreground">You have not asked for stock yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {mine.data.myRequests.map((request) => (
                <li key={request.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">
                      {plainQuantity(request.requestedQty)} × {request.productName}
                    </span>
                    <span className="block text-muted-foreground">
                      {STATUS_LABEL[request.status]}
                      {request.status === "APPROVED" && request.approvedQty !== null && request.approvedQty !== request.requestedQty
                        ? ` (${plainQuantity(request.approvedQty)} sent)`
                        : ""}{" "}
                      · {formatDateTime(request.createdAt)}
                    </span>
                  </span>
                  {request.status === "PENDING" ? (
                    <Button type="button" variant="ghost" className="h-11" onClick={() => void withdraw(request)}>
                      Withdraw
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  }

  return (
    <Sheet title="Stock at your till" description="Ask your manager for more. A request moves nothing until it is approved." onClose={onClose} wide>
      {content}
    </Sheet>
  );
}
