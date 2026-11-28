"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { centsToAmount, formatKES, parseCents, parseMajorToCents } from "@/lib/money";
import { closeShift } from "@/lib/pos/api";
import { posKeys } from "@/lib/pos/hooks";
import { TENDER_LABEL, type ShiftSummary } from "@/lib/pos/types";
import { cn } from "@/lib/utils";
import { shillings } from "./open-shift";

// Closing a shift: the cashier counts the drawer, confirms, and the SERVER works out what the
// drawer should hold (opening float + cash taken − cash refunded) and the variance. The till shows
// those figures as the server returns them — it does not compute the expected cash itself.

const schema = z.object({ closingFloat: shillings("cash counted in the drawer") });
type Values = z.infer<typeof schema>;

/** "Short", "Over" or "Balanced", with the signed amount — read from the server's variance. */
export function describeVariance(variance: string): { label: string; amount: string; tone: "short" | "over" | "even" } {
  const value = parseCents(variance);
  if (value < 0n) return { label: "Short", amount: `−KES ${formatKES(-value)}`, tone: "short" };
  if (value > 0n) return { label: "Over", amount: `+KES ${formatKES(value)}`, tone: "over" };
  return { label: "Balanced", amount: "KES 0.00", tone: "even" };
}

function Result({ closed, onDone }: { closed: ShiftSummary; onDone: () => void }) {
  const variance = describeVariance(closed.variance ?? "0");
  return (
    <div className="space-y-5" role="status">
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between">
          <dt>Expected in the drawer</dt>
          <dd className="tabular-nums">KES {formatKES(closed.expectedCash ?? "0")}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Counted</dt>
          <dd className="tabular-nums">KES {formatKES(closed.closingFloat ?? "0")}</dd>
        </div>
        <div
          className={cn(
            "flex justify-between rounded-md px-3 py-2 text-base font-semibold",
            variance.tone === "short" && "bg-destructive/10 text-destructive",
            variance.tone === "over" && "bg-amber-500/10 text-foreground",
            variance.tone === "even" && "bg-emerald-700/10 text-foreground",
          )}
        >
          <dt>{variance.label}</dt>
          <dd className="tabular-nums">{variance.amount}</dd>
        </div>
      </dl>
      <table className="w-full text-sm">
        <caption className="mb-2 text-left font-medium">Takings by payment type</caption>
        <tbody>
          {(Object.keys(closed.tenderBreakdown) as Array<keyof ShiftSummary["tenderBreakdown"]>).map((type) => (
            <tr key={type} className="border-b last:border-b-0">
              <th scope="row" className="py-1 text-left font-normal">
                {TENDER_LABEL[type]}
              </th>
              <td className="py-1 text-right tabular-nums">KES {formatKES(closed.tenderBreakdown[type])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm text-muted-foreground">
        {closed.saleCount.toString()} sales · KES {formatKES(closed.gross)} in all. Opening float KES {formatKES(closed.openingFloat)}.
      </p>
      <Button type="button" className="h-12 w-full" onClick={onDone} data-autofocus>
        Done
      </Button>
    </div>
  );
}

export function CloseShift({ shift, saleInProgress, onClose }: { shift: ShiftSummary; saleInProgress: boolean; onClose: (closed: boolean) => void }) {
  const client = useQueryClient();
  const ids = { counted: useId(), error: useId(), confirm: useId(), body: useId() };
  const [counted, setCounted] = useState<string | null>(null);
  const [closed, setClosed] = useState<ShiftSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { closingFloat: "" } });

  async function confirm() {
    if (counted === null) return;
    setClosing(true);
    setError(null);
    try {
      setClosed(await closeShift(shift.id, counted));
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The shift could not be closed. Please try again.");
      setCounted(null);
    } finally {
      setClosing(false);
    }
  }

  async function done() {
    await client.invalidateQueries({ queryKey: posKeys.all });
    onClose(true);
  }

  return (
    <Sheet title={closed ? "Shift closed" : "Close your shift"} onClose={closed ? () => void done() : () => onClose(false)}>
      {closed ? (
        <Result closed={closed} onDone={() => void done()} />
      ) : counted === null ? (
        <form noValidate onSubmit={handleSubmit(({ closingFloat }) => setCounted(centsToAmount(parseMajorToCents(closingFloat))))} className="space-y-4">
          {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
          <p className="text-sm text-muted-foreground">Count every note and coin in the drawer, including the float you opened with.</p>
          <TextField id={ids.counted} label="Cash counted (KES)" inputMode="decimal" autoComplete="off" data-autofocus error={errors.closingFloat?.message} {...register("closingFloat")} />
          <Button type="submit" className="h-12 w-full">
            Review and close
          </Button>
        </form>
      ) : (
        <div role="alertdialog" aria-labelledby={ids.confirm} aria-describedby={ids.body} className="space-y-4">
          <p id={ids.confirm} className="font-medium">
            Close the shift with KES {formatKES(parseMajorToCents(counted))} counted?
          </p>
          <p id={ids.body} className="text-sm">
            You cannot sell on this shift after closing.{saleInProgress ? " The sale in the cart has not been charged and will be cleared." : ""}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="h-12" onClick={() => setCounted(null)} disabled={closing} data-autofocus>
              Back
            </Button>
            <Button type="button" className="h-12 flex-1" onClick={() => void confirm()} disabled={closing}>
              {closing ? "Closing…" : "Yes, close the shift"}
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
