"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { centsToAmount, parseMajorToCents } from "@/lib/money";
import { openShift } from "@/lib/pos/api";
import { posKeys } from "@/lib/pos/hooks";

// The shift gate: nothing sells until the cashier has opened a shift with the cash already in the
// drawer (the opening float), because the shift's expected cash is counted from it.

export const shillings = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter the ${label}.`)
    .refine((value) => {
      try {
        return parseMajorToCents(value) >= 0n;
      } catch {
        return false;
      }
    }, "Enter an amount in shillings, e.g. 1,000 or 1500.50.");

const schema = z.object({ openingFloat: shillings("cash in the drawer") });
type Values = z.infer<typeof schema>;

/**
 * `locationId` is sent only by an owner or manager, who choose where they sell; a cashier sends
 * none and the server opens the shift at their assigned till (anything else it refuses).
 */
export function OpenShift({ locationName, locationId }: { locationName: string; locationId?: string }) {
  const client = useQueryClient();
  const ids = { float: useId(), form: useId() };
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { openingFloat: "" } });

  async function onSubmit({ openingFloat }: Values) {
    setError(null);
    try {
      await openShift(centsToAmount(parseMajorToCents(openingFloat)), locationId);
      await client.invalidateQueries({ queryKey: posKeys.all });
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The shift could not be opened. Please try again.");
    }
  }

  return (
    <section aria-labelledby={ids.form} className="mx-auto max-w-md space-y-5 rounded-lg border p-5">
      <div className="space-y-1">
        <h2 id={ids.form} className="font-display text-xl font-semibold">
          Open your shift
        </h2>
        <p className="text-sm text-muted-foreground">
          Count the cash in the drawer before your first sale at <span className="font-medium text-foreground">{locationName}</span>. It is
          what your shift is reconciled from when you close it.
        </p>
      </div>
      <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error ? <FormAlert id={`${ids.form}-error`}>{error}</FormAlert> : null}
        <TextField
          id={ids.float}
          label="Cash in the drawer (KES)"
          inputMode="decimal"
          autoComplete="off"
          data-autofocus
          error={errors.openingFloat?.message}
          {...register("openingFloat")}
        />
        <Button type="submit" className="h-12 w-full text-base" disabled={isSubmitting}>
          {isSubmitting ? "Opening…" : "Open shift"}
        </Button>
      </form>
    </section>
  );
}
