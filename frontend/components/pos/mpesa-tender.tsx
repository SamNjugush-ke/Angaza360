"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { centsToAmount, formatKES } from "@/lib/money";
import { pushStk } from "@/lib/pos/api";
import { stkTiming, useStkStatus } from "@/lib/pos/hooks";
import { draftStk, toMsisdn, typedCents, type MpesaTender, type TenderLine } from "@/lib/pos/tender";
import type { MpesaChannel, StkStatus } from "@/lib/pos/types";

// One M-Pesa tender, two ways in.
//   STK — the till prompts the customer's phone for the amount (a PRE-SALE push: nothing is
//   posted), then waits for M-Pesa's answer. Confirmed, the payment is fixed to this sale and goes
//   with it as its checkout id. Refused, timed out or unanswered, the cashier can prompt again,
//   switch to the code from the customer's message, or remove the line — the till never dead-ends.
//   MANUAL — the cashier saw the payment on the customer's phone (a Till or Paybill payment, or a
//   prompt that answered late) and keys in its code and channel.

const CHANNELS: ReadonlyArray<{ value: MpesaChannel; label: string }> = [
  { value: "TILL", label: "Till (Buy Goods)" },
  { value: "PAYBILL", label: "Paybill" },
  { value: "STK", label: "Phone prompt (answered late)" },
];

function failureOf(status: StkStatus): string {
  if (status.status === "TIMED_OUT") return "The M-Pesa prompt timed out before the customer paid.";
  const why = status.resultDesc?.trim();
  return why ? `The customer did not complete the M-Pesa payment (${why}).` : "The customer did not complete the M-Pesa payment.";
}

export interface MpesaFieldsProps {
  line: TenderLine;
  mpesa: MpesaTender;
  onChange: (line: TenderLine) => void;
  onRemove: () => void;
}

export function MpesaFields({ line, mpesa, onChange, onRemove }: MpesaFieldsProps) {
  const ids = { phone: useId(), code: useId(), channel: useId(), error: useId() };
  const [pushing, setPushing] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  const waiting = mpesa.mode === "stk" && mpesa.stage === "waiting";
  const status = useStkStatus(mpesa.mode === "stk" ? mpesa.checkoutRequestId : null, waiting);

  // Apply M-Pesa's answer to the line. The latest line and handler are read through a ref so the
  // effect runs once per answer, not once per render.
  const latest = useRef({ line, mpesa, onChange });
  useEffect(() => {
    latest.current = { line, mpesa, onChange };
  });
  const answer = status.data;
  const answeredAt = status.dataUpdatedAt;
  useEffect(() => {
    const { line: current, mpesa: tender, onChange: update } = latest.current;
    if (answer === undefined || tender.mode !== "stk" || tender.stage !== "waiting" || answer.checkoutRequestId !== tender.checkoutRequestId) return;
    if (answer.status === "CALLBACK_OK") {
      update({ ...current, mpesa: { ...tender, stage: "confirmed", receiptNumber: answer.mpesaReceiptNumber, failure: null } });
    } else if (answer.status === "CALLBACK_FAILED" || answer.status === "TIMED_OUT") {
      update({ ...current, mpesa: { ...tender, stage: "failed", failure: failureOf(answer) } });
    } else if (tender.sentAt !== null && Date.now() - tender.sentAt >= stkTiming.quietAfterMs) {
      update({ ...current, mpesa: { ...tender, stage: "quiet", failure: "No answer from M-Pesa yet." } });
    }
  }, [answer, answeredAt]);

  async function prompt() {
    if (mpesa.mode !== "stk") return;
    const phoneNumber = toMsisdn(mpesa.phone);
    const amount = typedCents(line.amount);
    if (phoneNumber === null) {
      setInputError("Enter the customer's M-Pesa number, e.g. 0712 345 678.");
      return;
    }
    if (amount === null || amount <= 0n) {
      setInputError("Enter the amount to ask the customer for.");
      return;
    }
    setInputError(null);
    setPushing(true);
    try {
      const sent = await pushStk({ phoneNumber, amount: centsToAmount(amount) });
      onChange({
        ...line,
        stale: false,
        mpesa: { mode: "stk", phone: mpesa.phone, stage: "waiting", checkoutRequestId: sent.checkoutRequestId, sentAt: Date.now(), receiptNumber: null, failure: null },
      });
    } catch (failure) {
      const message = failure instanceof ApiHttpError ? failure.message : "The prompt could not be sent. Please try again.";
      onChange({ ...line, mpesa: { ...mpesa, stage: "failed", checkoutRequestId: null, sentAt: null, failure: `The prompt was not sent: ${message}` } });
    } finally {
      setPushing(false);
    }
  }

  const toManual = () =>
    onChange({ ...line, stale: false, mpesa: { mode: "manual", channel: mpesa.mode === "stk" && mpesa.checkoutRequestId !== null ? "STK" : "TILL", reference: "" } });

  if (mpesa.mode === "manual") {
    return (
      <div className="space-y-3">
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Paid to</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {CHANNELS.map((channel) => (
              <label key={channel.value} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={ids.channel}
                  value={channel.value}
                  checked={mpesa.channel === channel.value}
                  onChange={() => onChange({ ...line, mpesa: { ...mpesa, channel: channel.value } })}
                  className="size-4"
                />
                {channel.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="space-y-1">
          <Label htmlFor={ids.code}>M-Pesa code</Label>
          <Input
            id={ids.code}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="e.g. QK7AB12CDE"
            className="h-11 w-48 uppercase"
            value={mpesa.reference}
            onChange={(event) => onChange({ ...line, mpesa: { ...mpesa, reference: event.target.value } })}
          />
        </div>
        <Button type="button" variant="ghost" className="h-11 px-2" onClick={() => onChange({ ...line, mpesa: draftStk() })}>
          Prompt the customer&rsquo;s phone instead
        </Button>
      </div>
    );
  }

  const canPrompt = mpesa.stage === "draft" || mpesa.stage === "failed" || mpesa.stage === "quiet";
  return (
    <div className="space-y-3">
      {canPrompt ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor={ids.phone}>Customer phone</Label>
            <Input
              id={ids.phone}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="0712 345 678"
              className="h-11 w-44"
              value={mpesa.phone}
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? ids.error : undefined}
              onChange={(event) => onChange({ ...line, mpesa: { ...mpesa, phone: event.target.value } })}
            />
          </div>
          <Button type="button" className="h-11" onClick={() => void prompt()} disabled={pushing}>
            {pushing ? "Sending the prompt…" : mpesa.stage === "draft" ? "Prompt customer (STK)" : "Prompt again"}
          </Button>
          <Button type="button" variant="outline" className="h-11" onClick={toManual} disabled={pushing}>
            Enter the M-Pesa code instead
          </Button>
        </div>
      ) : null}
      {inputError ? (
        <p id={ids.error} className="text-sm text-destructive">
          {inputError}
        </p>
      ) : null}

      <div aria-live="polite" role="status" className="text-sm">
        {mpesa.stage === "waiting" ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
            <p>
              <span className="mr-2 inline-block size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" aria-hidden />
              Waiting for the customer to enter their M-Pesa PIN… (KES {formatKES(typedCents(line.amount) ?? 0n)})
            </p>
            <Button type="button" variant="outline" className="h-11" onClick={() => void status.refetch()}>
              Check now
            </Button>
          </div>
        ) : null}
        {mpesa.stage === "confirmed" ? (
          <p className="rounded-md bg-emerald-700/10 px-3 py-2 font-medium">
            M-Pesa confirmed{mpesa.receiptNumber ? ` · receipt ${mpesa.receiptNumber}` : ""}. This payment is received and goes with this sale.
          </p>
        ) : null}
        {mpesa.stage === "failed" || mpesa.stage === "quiet" ? (
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
            <p className="font-medium text-destructive">{mpesa.failure}</p>
            {mpesa.stage === "quiet" ? (
              <p>Look at the customer&rsquo;s phone first: if they have paid, enter the code from their M-Pesa message rather than prompting again.</p>
            ) : (
              <p>Prompt again, take the code from the customer&rsquo;s M-Pesa message, or remove this payment.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {mpesa.stage === "quiet" ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  onClick={() => onChange({ ...line, mpesa: { ...mpesa, stage: "waiting", sentAt: Date.now(), failure: null } })}
                >
                  Keep waiting
                </Button>
              ) : null}
              <Button type="button" variant="outline" className="h-11" onClick={onRemove}>
                Remove this payment
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
