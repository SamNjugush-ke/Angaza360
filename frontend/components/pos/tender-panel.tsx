"use client";

import { Trash2 } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { centsToAmount, formatKES } from "@/lib/money";
import { amountEditable, evaluateTenders, holdsMpesaMoney, newTender, typedCents, type TenderEvaluation, type TenderLine } from "@/lib/pos/tender";
import { TENDER_LABEL, type Customer, type TillTenderType } from "@/lib/pos/types";
import { cn } from "@/lib/utils";
import { MpesaFields } from "./mpesa-tender";

// Taking payment against the quote's total: one or more tenders (cash, M-Pesa, bank transfer, credit),
// a running "tendered vs outstanding", the change from cash handed over, and Charge — enabled only
// when the tenders add up to the total to the cent.

const TYPES: readonly TillTenderType[] = ["CASH", "MPESA", "BANK_TRANSFER", "CREDIT"];

/** A tender's name inside a sentence: "cash", "bank transfer" — but "M-Pesa" stays a proper noun. */
const inSentence = (type: TillTenderType) => (type === "MPESA" ? TENDER_LABEL.MPESA : TENDER_LABEL[type].toLowerCase());

function TenderRow({
  line,
  problem,
  outstanding,
  onChange,
  onRemove,
}: {
  line: TenderLine;
  problem: string | undefined;
  outstanding: bigint;
  onChange: (line: TenderLine) => void;
  onRemove: () => void;
}) {
  const ids = { amount: useId(), received: useId(), note: useId() };
  const label = TENDER_LABEL[line.type];
  const editable = amountEditable(line);
  // A prompted push reports its own state (waiting, confirmed, refused) in its status line.
  const stkReports = line.mpesa?.mode === "stk" && line.mpesa.stage !== "draft";
  const shownProblem = stkReports && !line.stale ? undefined : problem;
  return (
    <li className={cn("space-y-2 rounded-lg border p-3", problem && "border-destructive/50")}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{label}</p>
        {holdsMpesaMoney(line) ? null : (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${inSentence(line.type)} payment`}
            className="flex size-11 items-center justify-center rounded-md text-destructive hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={ids.amount}>{label} amount (KES)</Label>
          <Input
            id={ids.amount}
            inputMode="decimal"
            autoComplete="off"
            className="h-11 w-36 tabular-nums"
            value={line.amount}
            readOnly={!editable}
            aria-invalid={shownProblem ? true : undefined}
            aria-describedby={shownProblem ? ids.note : undefined}
            onChange={(event) => onChange({ ...line, amount: event.target.value, stale: false })}
          />
        </div>
        {outstanding > 0n && editable ? (
          <Button type="button" variant="outline" className="h-11" onClick={() => onChange({ ...line, amount: centsToAmount(outstandingPlus(line, outstanding)), stale: false })}>
            Pay the rest
          </Button>
        ) : null}
        {line.type === "CASH" ? (
          <div className="space-y-1">
            <Label htmlFor={ids.received}>Cash received (KES)</Label>
            <Input
              id={ids.received}
              inputMode="decimal"
              autoComplete="off"
              placeholder="optional"
              className="h-11 w-36 tabular-nums"
              value={line.cashReceived}
              onChange={(event) => onChange({ ...line, cashReceived: event.target.value })}
            />
          </div>
        ) : null}
      </div>
      {line.type === "MPESA" && line.mpesa ? <MpesaFields line={line} mpesa={line.mpesa} onChange={onChange} onRemove={onRemove} /> : null}
      {shownProblem ? (
        <p id={ids.note} className="text-sm text-destructive">
          {shownProblem}
        </p>
      ) : null}
    </li>
  );
}

/** This line's amount plus what is still outstanding — "pay the rest" with this tender. */
function outstandingPlus(line: TenderLine, outstanding: bigint): bigint {
  return (typedCents(line.amount) ?? 0n) + outstanding;
}

export interface TenderPanelProps {
  total: bigint;
  tenders: readonly TenderLine[];
  customer: Customer | null;
  onChange: (tenders: TenderLine[]) => void;
  onCharge: () => void;
  onBack: () => void;
  charging: boolean;
  /** The quote is being re-asked (e.g. the customer changed): the total may move, so no charge yet. */
  repricing: boolean;
  error: string | null;
  /** Said once the total has moved under the payment (a re-quote). */
  notice?: string | null;
}

export function TenderPanel({ total, tenders, customer, onChange, onCharge, onBack, charging, repricing, error, notice = null }: TenderPanelProps) {
  const evaluation: TenderEvaluation = evaluateTenders(tenders, total, customer);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-lg border p-4">
      <h2 id={headingId} className="font-display text-lg font-semibold">
        Take payment
      </h2>
      {error ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      <ul aria-label="Payments" className="space-y-2">
        {tenders.map((line) => (
          <TenderRow
            key={line.id}
            line={line}
            problem={evaluation.problems[line.id]}
            outstanding={evaluation.outstanding}
            onChange={(next) => onChange(tenders.map((row) => (row.id === line.id ? next : row)))}
            onRemove={() => onChange(tenders.filter((row) => row.id !== line.id))}
          />
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {TYPES.map((type) => (
          <Button key={type} type="button" variant="outline" className="h-11" onClick={() => onChange([...tenders, newTender(type, evaluation.outstanding)])}>
            Add {inSentence(type)}
          </Button>
        ))}
      </div>

      <dl className="space-y-1 rounded-md bg-muted p-3 text-sm" aria-live="polite">
        <div className="flex justify-between">
          <dt>Total</dt>
          <dd className="tabular-nums">KES {formatKES(total)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Tendered</dt>
          <dd className="tabular-nums">KES {formatKES(evaluation.tendered)}</dd>
        </div>
        <div className={cn("flex justify-between font-semibold", evaluation.outstanding !== 0n && "text-destructive")}>
          <dt>{evaluation.outstanding < 0n ? "Over by" : "Outstanding"}</dt>
          <dd className="tabular-nums">KES {formatKES(evaluation.outstanding < 0n ? -evaluation.outstanding : evaluation.outstanding)}</dd>
        </div>
        {evaluation.change > 0n ? (
          <div className="flex justify-between pt-1 text-base font-semibold text-primary">
            <dt>Change to give</dt>
            <dd className="tabular-nums">KES {formatKES(evaluation.change)}</dd>
          </div>
        ) : null}
      </dl>
      {evaluation.blocking ? (
        <p role="alert" className="text-sm text-destructive">
          {evaluation.blocking}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-12" onClick={onBack} disabled={charging}>
          Back to the cart
        </Button>
        <Button type="button" className="h-12 flex-1 text-base" disabled={!evaluation.canCharge || charging || repricing} onClick={onCharge}>
          {charging ? "Charging…" : repricing ? "Updating the total…" : `Charge KES ${formatKES(total)}`}
        </Button>
      </div>
    </section>
  );
}
