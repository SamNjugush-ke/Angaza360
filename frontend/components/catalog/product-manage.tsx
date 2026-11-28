"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { useToast } from "@/components/toast/toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { setActive, setReorderPolicy, setTaxClass } from "@/lib/catalog/api";
import { useInvalidateCatalog } from "@/lib/catalog/hooks";
import type { CatalogPermissions } from "@/lib/catalog/permissions";
import { TAX_CLASS_LABEL, TAX_CLASSES, type Product, type TaxClass } from "@/lib/catalog/types";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatQuantity } from "./product-detail";

// A product's managed settings, below its details: the reorder policy (who may restock), the tax
// class and activation (owner / manager). Each section renders only for a role the backend lets
// use it; each change answers with a toast and shows the product as the API returned it.

const QUANTITY = /^\d+(\.\d{1,3})?$/;
const isZero = (value: string) => /^0+(\.0+)?$/.test(value);

const reorderSchema = z.object({
  minStockThreshold: z.string().trim().min(1, "Enter a reorder level (0 for none).").regex(QUANTITY, "Use a number with up to 3 decimals, e.g. 20 or 2.5."),
  reorderQuantity: z
    .string()
    .trim()
    .refine((value) => value === "" || QUANTITY.test(value), "Use a number with up to 3 decimals, e.g. 100.")
    .refine((value) => value === "" || !isZero(value), "Leave it empty for none, or enter more than 0."),
});
type ReorderValues = z.infer<typeof reorderSchema>;

const messageOf = (error: unknown) => (error instanceof ApiHttpError ? error.message : "The change could not be saved. Please try again.");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t pt-5">
      <h3 className="font-display text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ReorderPolicy({ product, onChanged }: { product: Product; onChanged: (product: Product) => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateCatalog();
  const ids = { level: useId(), quantity: useId(), form: useId() };
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ReorderValues>({
    resolver: zodResolver(reorderSchema),
    defaultValues: {
      minStockThreshold: formatQuantity(product.minStockThreshold),
      reorderQuantity: product.reorderQuantity === null ? "" : formatQuantity(product.reorderQuantity),
    },
  });

  async function onSubmit(values: ReorderValues) {
    setFormError(null);
    try {
      const saved = await setReorderPolicy(product.id, {
        minStockThreshold: values.minStockThreshold,
        reorderQuantity: values.reorderQuantity === "" ? null : values.reorderQuantity,
      });
      await invalidate();
      toast({ title: "Reorder policy saved", description: saved.name, tone: "success" });
      onChanged(saved);
    } catch (error) {
      setFormError(messageOf(error));
      toast({ title: "Reorder policy not saved", description: messageOf(error), tone: "error" });
    }
  }

  return (
    <Section title="Reorder policy">
      <p className="text-sm text-muted-foreground">You are alerted when stock at a location falls to the reorder level. 0 means no alert.</p>
      <form noValidate onSubmit={handleSubmit(onSubmit)} aria-describedby={formError ? ids.form : undefined} className="space-y-4">
        {formError ? <FormAlert id={ids.form}>{formError}</FormAlert> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id={ids.level} label={`Reorder level (${product.unitOfMeasure})`} inputMode="decimal" autoComplete="off" error={errors.minStockThreshold?.message} {...register("minStockThreshold")} />
          <TextField id={ids.quantity} label={`Reorder quantity (${product.unitOfMeasure})`} optional inputMode="decimal" autoComplete="off" hint="How much you usually order." error={errors.reorderQuantity?.message} {...register("reorderQuantity")} />
        </div>
        <Button type="submit" variant="outline" className="h-11" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save reorder policy"}
        </Button>
      </form>
    </Section>
  );
}

const SELECT_CLASS =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm";

function TaxClassControl({ product, onChanged }: { product: Product; onChanged: (product: Product) => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateCatalog();
  const id = useId();
  const [value, setValue] = useState<TaxClass>(product.taxClass);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const saved = await setTaxClass(product.id, value);
      await invalidate();
      toast({ title: `Tax class set to ${TAX_CLASS_LABEL[saved.taxClass]}`, description: saved.name, tone: "success" });
      onChanged(saved);
    } catch (error) {
      setValue(product.taxClass);
      toast({ title: "Tax class not changed", description: messageOf(error), tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Tax class">
      <p className="text-sm text-muted-foreground">Decides the VAT on future sales of this product. Sales already made keep the class they were sold under.</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-2">
          <Label htmlFor={id}>Tax class</Label>
          <select id={id} className={SELECT_CLASS} value={value} onChange={(event) => setValue(event.target.value as TaxClass)}>
            {TAX_CLASSES.map((option) => (
              <option key={option} value={option}>
                {TAX_CLASS_LABEL[option]}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" variant="outline" className="h-11" disabled={saving || value === product.taxClass} onClick={() => void save()}>
          {saving ? "Saving…" : "Save tax class"}
        </Button>
      </div>
    </Section>
  );
}

function Activation({ product, onChanged }: { product: Product; onChanged: (product: Product) => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateCatalog();
  const ids = { title: useId(), body: useId() };
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const activating = !product.isActive;

  async function confirm() {
    setSaving(true);
    try {
      const saved = await setActive(product.id, activating);
      await invalidate();
      toast({ title: saved.isActive ? "Product reactivated" : "Product deactivated", description: saved.name, tone: "success" });
      setConfirming(false);
      onChanged(saved);
    } catch (error) {
      await invalidate();
      toast({ title: activating ? "Not reactivated" : "Not deactivated", description: messageOf(error), tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title={activating ? "Reactivate" : "Deactivate"}>
      {confirming ? (
        <div role="alertdialog" aria-labelledby={ids.title} aria-describedby={ids.body} className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4">
          <p id={ids.title} className="font-medium">
            {activating ? `Reactivate ${product.name}?` : `Deactivate ${product.name}?`}
          </p>
          <p id={ids.body} className="text-sm">
            {activating
              ? "It can be sold and restocked again."
              : "It can no longer be sold or restocked. Its stock stays on your books, and you can reactivate it at any time."}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="h-11" disabled={saving} onClick={() => setConfirming(false)} data-autofocus>
              {activating ? "Cancel" : "Keep active"}
            </Button>
            <Button type="button" variant={activating ? "default" : "destructive"} className="h-11" disabled={saving} onClick={() => void confirm()}>
              {saving ? "Saving…" : activating ? "Yes, reactivate" : "Yes, deactivate"}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {activating ? "This product is inactive: it cannot be sold or restocked." : "Stop selling and restocking this product. Nothing is deleted."}
          </p>
          <Button type="button" variant="outline" className="h-11" onClick={() => setConfirming(true)}>
            {activating ? "Reactivate product" : "Deactivate product"}
          </Button>
        </>
      )}
    </Section>
  );
}

export interface ProductManageProps {
  product: Product;
  permissions: CatalogPermissions;
  onChanged: (product: Product) => void;
}

/** The write controls under a product's details — each only for a role allowed to use it. */
export function ProductManage({ product, permissions, onChanged }: ProductManageProps) {
  return (
    <div className="space-y-5">
      {permissions.canReorder ? (
        product.kind === "GOOD" ? (
          <ReorderPolicy key={`${product.id}-${product.updatedAt}`} product={product} onChanged={onChanged} />
        ) : (
          <Section title="Reorder policy">
            <p className="text-sm text-muted-foreground">Services carry no stock, so they have no reorder level.</p>
          </Section>
        )
      ) : null}
      {permissions.canSetTaxClass ? <TaxClassControl key={`${product.id}-${product.taxClass}`} product={product} onChanged={onChanged} /> : null}
      {permissions.canActivate ? <Activation key={`${product.id}-${String(product.isActive)}`} product={product} onChanged={onChanged} /> : null}
    </div>
  );
}
