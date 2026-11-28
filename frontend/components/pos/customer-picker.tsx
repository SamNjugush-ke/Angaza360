"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { ErrorState, LoadingState } from "@/components/states/states";
import { useToast } from "@/components/toast/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { centsToAmount, formatKES, parseCents, parseMajorToCents } from "@/lib/money";
import { createCustomer } from "@/lib/pos/api";
import { posKeys, useCustomers } from "@/lib/pos/hooks";
import type { Customer } from "@/lib/pos/types";

// The sale's customer: optional, but REQUIRED for credit. The list comes from GET /v1/customers
// (every customer, by name) and is filtered here; a new customer can be added on the spot.

/** What the customer may still put on credit, in cents (a display pre-check; the sale re-checks). */
export function creditLeft(customer: Customer): bigint {
  return parseCents(customer.creditLimit) - parseCents(customer.creditBalance);
}

function matches(customer: Customer, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return customer.name.toLowerCase().includes(q) || (customer.phone ?? "").includes(q) || (customer.kraPin ?? "").toLowerCase().includes(q);
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Enter the customer's name.").max(200, "At most 200 characters."),
  phone: z.string().trim().max(20, "At most 20 characters."),
  creditLimit: z
    .string()
    .trim()
    .refine((value) => {
      if (value === "") return true;
      try {
        return parseMajorToCents(value) >= 0n;
      } catch {
        return false;
      }
    }, "Enter the credit limit in shillings, e.g. 5,000."),
});
type CreateValues = z.infer<typeof createSchema>;

function QuickCreate({ canSetCredit, onCreated }: { canSetCredit: boolean; onCreated: (customer: Customer) => void }) {
  const client = useQueryClient();
  const { toast } = useToast();
  const ids = { name: useId(), phone: useId(), credit: useId(), form: useId() };
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<CreateValues>({ resolver: zodResolver(createSchema), defaultValues: { name: "", phone: "", creditLimit: "" } });

  async function onSubmit(values: CreateValues) {
    setError(null);
    try {
      const created = await createCustomer({
        name: values.name,
        ...(values.phone !== "" ? { phone: values.phone } : {}),
        ...(canSetCredit && values.creditLimit !== "" ? { creditLimit: centsToAmount(parseMajorToCents(values.creditLimit)) } : {}),
      });
      await client.invalidateQueries({ queryKey: posKeys.customers() });
      toast({ title: "Customer added", description: created.name, tone: "success" });
      onCreated(created);
    } catch (failure) {
      if (failure instanceof ApiHttpError && failure.status === 409) {
        setFieldError("phone", { type: "server", message: "Another customer already has this phone number." });
        return;
      }
      setError(failure instanceof ApiHttpError ? failure.message : "The customer could not be added. Please try again.");
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4" aria-labelledby={ids.form}>
      <h3 id={ids.form} className="font-display text-base font-semibold">
        New customer
      </h3>
      {error ? <FormAlert id={`${ids.form}-error`}>{error}</FormAlert> : null}
      <TextField id={ids.name} label="Name" autoComplete="off" error={errors.name?.message} {...register("name")} />
      <TextField id={ids.phone} label="Phone" optional type="tel" inputMode="tel" autoComplete="off" error={errors.phone?.message} {...register("phone")} />
      {canSetCredit ? (
        <TextField id={ids.credit} label="Credit limit (KES)" optional inputMode="decimal" autoComplete="off" hint="0 or empty: cash customer only." error={errors.creditLimit?.message} {...register("creditLimit")} />
      ) : (
        <p className="text-sm text-muted-foreground">A new customer starts with no credit. An owner or manager can set a credit limit.</p>
      )}
      <Button type="submit" variant="outline" className="h-11 w-full" disabled={isSubmitting}>
        {isSubmitting ? "Adding…" : "Add and select"}
      </Button>
    </form>
  );
}

export interface CustomerPickerProps {
  customer: Customer | null;
  onChange: (customer: Customer | null) => void;
  /** Owner / manager may set a new customer's credit limit at the till. */
  canSetCredit: boolean;
}

export function CustomerPicker({ customer, onChange, canSetCredit }: CustomerPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const customers = useCustomers();

  const choose = (picked: Customer) => {
    onChange(picked);
    setOpen(false);
    setQuery("");
  };

  return (
    <section aria-label="Customer" className="space-y-2">
      {customer ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <UserRound className="size-5 text-muted-foreground" aria-hidden />
            <div>
              <p className="font-medium">{customer.name}</p>
              <p className="text-xs text-muted-foreground">
                {customer.phone ? `${customer.phone} · ` : ""}Credit left KES {formatKES(creditLeft(customer))}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={() => setOpen(true)}>
              Change
            </Button>
            <Button type="button" variant="ghost" className="h-11" onClick={() => onChange(null)}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" className="h-11 w-full justify-start" onClick={() => setOpen(true)}>
          <UserRound aria-hidden /> Add customer <span className="font-normal text-muted-foreground">(optional; needed for credit)</span>
        </Button>
      )}

      {open ? (
        <Sheet title="Choose a customer" onClose={() => setOpen(false)}>
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor={searchId}>Search customers</Label>
              <Input id={searchId} type="search" autoComplete="off" className="h-11" placeholder="Name, phone or KRA PIN" value={query} onChange={(event) => setQuery(event.target.value)} data-autofocus />
              {customers.isPending ? (
                <LoadingState label="Loading customers" />
              ) : customers.isError ? (
                <ErrorState size="inline" title="Couldn’t load customers" onRetry={() => void customers.refetch()} />
              ) : (
                <ul aria-label="Customers" className="max-h-72 space-y-1 overflow-y-auto">
                  {customers.data.data
                    .filter((row) => row.isActive && matches(row, query))
                    .slice(0, 30)
                    .map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => choose(row)}
                          className="flex min-h-12 w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{row.name}</span>
                            <span className="block text-xs text-muted-foreground">{row.phone ?? "No phone"}</span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">Credit left KES {formatKES(creditLeft(row))}</span>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </div>
            <QuickCreate canSetCredit={canSetCredit} onCreated={choose} />
          </div>
        </Sheet>
      ) : null}
    </section>
  );
}
