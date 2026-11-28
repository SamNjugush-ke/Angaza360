"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { Role } from "@/lib/auth/landing";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatKES } from "@/lib/money";
import { voidSale } from "@/lib/pos/api";
import type { SaleRecord, VoidResult } from "@/lib/pos/types";

// Voiding a sale — a MANAGER's or OWNER's decision (the API refuses anyone else). The payment is
// reversed and the stock goes back to the location it was sold from; the sale itself is never
// edited. A reason is required and kept with the sale. A sale KRA had signed owes KRA a credit
// note: the server records it with the void and the till says so.

export const VOID_ROLES: readonly Role[] = ["MSME_MANAGER", "MSME_OWNER"];

export interface VoidSaleProps {
  sale: Pick<SaleRecord, "id" | "saleNumber" | "total" | "status" | "voidReason">;
  role: Role;
  onVoided: (result: VoidResult) => void;
  /** Shown under a refusal: the way forward, e.g. a link to open a shift for a cash refund. */
  refusalAction?: ReactNode;
}

type Stage = "idle" | "reason" | "confirm";

export function VoidSale({ sale, role, onVoided, refusalAction }: VoidSaleProps) {
  const ids = { reason: useId(), reasonError: useId(), note: useId(), confirm: useId(), body: useId() };
  const [stage, setStage] = useState<Stage>("idle");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [creditNote, setCreditNote] = useState<VoidResult["creditNote"]>(null);
  const focusTarget = useRef<HTMLElement | null>(null);
  useEffect(() => {
    focusTarget.current?.focus();
  }, [stage]);

  if (sale.status === "VOIDED") {
    return (
      <div role="status" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
        <p className="font-medium text-destructive">This sale is voided.{sale.voidReason ? ` Reason: ${sale.voidReason}` : ""}</p>
        {creditNote ? (
          <p>
            KRA had signed this sale, so a credit note (eTIMS no. {creditNote.etimsInvoiceNumber.toString()}) is owed to KRA. It has been recorded and is sent to KRA
            separately.
          </p>
        ) : null}
      </div>
    );
  }

  if (!VOID_ROLES.includes(role)) {
    return (
      <div className="space-y-1">
        <Button type="button" variant="outline" className="h-11" disabled aria-describedby={ids.note}>
          Void sale
        </Button>
        <p id={ids.note} className="text-sm text-muted-foreground">
          A manager must authorise a void.
        </p>
      </div>
    );
  }

  async function confirm() {
    setVoiding(true);
    setError(null);
    try {
      const result = await voidSale(sale.id, reason.trim());
      setCreditNote(result.creditNote);
      setStage("idle");
      onVoided(result);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The sale could not be voided. Please try again.");
      setStage("reason");
    } finally {
      setVoiding(false);
    }
  }

  if (stage === "idle") {
    return (
      <Button type="button" variant="outline" className="h-11 border-destructive/50 text-destructive" onClick={() => setStage("reason")}>
        Void sale
      </Button>
    );
  }

  if (stage === "reason") {
    return (
      <form
        noValidate
        className="space-y-3 rounded-md border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim() === "") {
            setReasonError("Give a reason — it is kept with the sale.");
            return;
          }
          setReasonError(null);
          setStage("confirm");
        }}
      >
        {error ? (
          <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <p className="text-destructive">{error}</p>
            {refusalAction}
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor={ids.reason}>Reason for the void</Label>
          <textarea
            id={ids.reason}
            ref={(node) => {
              focusTarget.current = node;
            }}
            rows={2}
            value={reason}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? ids.reasonError : undefined}
            onChange={(event) => setReason(event.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {reasonError ? (
            <p id={ids.reasonError} className="text-sm text-destructive">
              {reasonError}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="h-11" onClick={() => setStage("idle")}>
            Cancel
          </Button>
          <Button type="submit" className="h-11">
            Review the void
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div role="alertdialog" aria-labelledby={ids.confirm} aria-describedby={ids.body} className="space-y-3 rounded-md border border-destructive/50 p-3">
      <p id={ids.confirm} className="font-medium">
        Void {sale.saleNumber} for KES {formatKES(sale.total)}?
      </p>
      <p id={ids.body} className="text-sm">
        The payment is reversed and the stock goes back to where it was sold from. Reason: {reason.trim()}. This cannot be undone.
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button
          ref={(node) => {
            focusTarget.current = node;
          }}
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => setStage("reason")}
          disabled={voiding}
        >
          Back
        </Button>
        <Button type="button" variant="destructive" className="h-11 flex-1" onClick={() => void confirm()} disabled={voiding}>
          {voiding ? "Voiding…" : "Yes, void the sale"}
        </Button>
      </div>
    </div>
  );
}
