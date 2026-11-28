"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Info } from "lucide-react";
import { useId, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { useToast } from "@/components/toast/toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { createProduct, ProductConflictError, updateProduct } from "@/lib/catalog/api";
import { useInvalidateCatalog } from "@/lib/catalog/hooks";
import {
  KIND_LABEL,
  TAX_CLASS_LABEL,
  TAX_CLASSES,
  type Product,
  type ProductCreateBody,
  type ProductEditBody,
  type ProductKind,
  type TaxClass,
} from "@/lib/catalog/types";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { centsToAmount, parseCents, parseMajorToCents } from "@/lib/money";

// Add or edit a product. Money is typed in shillings ("1,250.50"), parsed by the ONE money parser
// (parseMajorToCents — a BigInt, never a JS number) and sent as the API's decimal string. Kind is
// chosen once, at creation (the backend freezes it). Tax class has its own owner/manager control,
// so the create form offers it only to those roles and the edit form not at all.

const MONEY_MESSAGE = "Enter an amount in shillings, e.g. 1,250.50.";

function moneyField(label: string) {
  return z
    .string()
    .trim()
    .min(1, `Enter the ${label}.`)
    .refine((value) => {
      try {
        return parseMajorToCents(value) >= 0n;
      } catch {
        return false;
      }
    }, MONEY_MESSAGE);
}

export const productFormSchema = z.object({
  sku: z.string().trim().min(1, "Enter a SKU — the code you use for this item.").max(100, "At most 100 characters."),
  name: z.string().trim().min(1, "Enter the product name.").max(200, "At most 200 characters."),
  kind: z.enum(["GOOD", "SERVICE"]),
  price: moneyField("selling price"),
  costPrice: moneyField("cost price"),
  taxClass: z.enum(["STANDARD_RATED", "ZERO_RATED", "EXEMPT"]),
  unitOfMeasure: z.string().trim().min(1, "Enter a unit, e.g. piece, kg or bag.").max(40, "At most 40 characters."),
  barcode: z.string().trim().max(64, "At most 64 characters."),
  category: z.string().trim().max(100, "At most 100 characters."),
});

export type ProductFormValues = z.infer<typeof productFormSchema>;

/** A typed amount as the API's decimal string — through the money parser, never as a JS number. */
export function toApiAmount(typed: string): string {
  return centsToAmount(parseMajorToCents(typed));
}

function valuesOf(product: Product | null): ProductFormValues {
  if (!product) {
    return { sku: "", name: "", kind: "GOOD", price: "", costPrice: "", taxClass: "STANDARD_RATED", unitOfMeasure: "unit", barcode: "", category: "" };
  }
  return {
    sku: product.sku,
    name: product.name,
    kind: product.kind,
    price: centsToAmount(product.price),
    costPrice: centsToAmount(product.costPrice),
    taxClass: product.taxClass,
    unitOfMeasure: product.unitOfMeasure,
    barcode: product.barcode ?? "",
    category: product.category ?? "",
  };
}

/** Only what changed, with a cleared optional field sent as null. */
function editBody(original: Product, values: ProductFormValues): ProductEditBody {
  const body: ProductEditBody = {};
  if (values.sku !== original.sku) body.sku = values.sku;
  if (values.name !== original.name) body.name = values.name;
  if (values.unitOfMeasure !== original.unitOfMeasure) body.unitOfMeasure = values.unitOfMeasure;
  if (parseMajorToCents(values.price) !== parseCents(original.price)) body.price = toApiAmount(values.price);
  if (parseMajorToCents(values.costPrice) !== parseCents(original.costPrice)) body.costPrice = toApiAmount(values.costPrice);
  if (values.barcode !== (original.barcode ?? "")) body.barcode = values.barcode === "" ? null : values.barcode;
  if (values.category !== (original.category ?? "")) body.category = values.category === "" ? null : values.category;
  return body;
}

function createBody(values: ProductFormValues, withTaxClass: boolean): ProductCreateBody {
  return {
    sku: values.sku,
    name: values.name,
    kind: values.kind,
    price: toApiAmount(values.price),
    costPrice: toApiAmount(values.costPrice),
    unitOfMeasure: values.unitOfMeasure,
    ...(withTaxClass ? { taxClass: values.taxClass } : {}),
    ...(values.barcode !== "" ? { barcode: values.barcode } : {}),
    ...(values.category !== "" ? { category: values.category } : {}),
  };
}

/** What each unique clash says on its own field — keyed by the backend's 409 `field`. */
export const CLASH_MESSAGE = {
  sku: "A product with this SKU already exists.",
  barcode: "A product with this barcode already exists.",
} as const;

const SELECT_CLASS =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm";

export interface ProductFormProps {
  /** null: add a new product; a product: edit it. */
  product: Product | null;
  categories: readonly string[];
  canSetTaxClass: boolean;
  onSaved: (product: Product) => void;
  onCancel: () => void;
}

export function ProductForm({ product, categories, canSetTaxClass, onSaved, onCancel }: ProductFormProps) {
  const editing = product !== null;
  const { toast } = useToast();
  const invalidate = useInvalidateCatalog();
  const [formError, setFormError] = useState<string | null>(null);
  const ids = {
    sku: useId(), name: useId(), kind: useId(), price: useId(), cost: useId(), tax: useId(),
    unit: useId(), barcode: useId(), category: useId(), categories: useId(), form: useId(),
  };
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    control,
    formState: { errors, isSubmitting },
  } = useForm<ProductFormValues>({ resolver: zodResolver(productFormSchema), defaultValues: valuesOf(product) });
  const kind = useWatch({ control, name: "kind" });

  async function onSubmit(values: ProductFormValues) {
    setFormError(null);
    if (editing && Object.keys(editBody(product, values)).length === 0) {
      onSaved(product);
      return;
    }
    try {
      const saved = editing ? await updateProduct(product.id, editBody(product, values)) : await createProduct(createBody(values, canSetTaxClass));
      await invalidate();
      toast({ title: editing ? "Changes saved" : "Product added", description: saved.name, tone: "success" });
      onSaved(saved);
    } catch (error) {
      const message = error instanceof ApiHttpError ? error.message : "The product could not be saved. Please try again.";
      // A unique clash names its field: the message goes on THAT input, and what was typed stays.
      if (error instanceof ProductConflictError) {
        setError(error.field, { type: "server", message: CLASH_MESSAGE[error.field] });
        setFocus(error.field);
        return;
      }
      setFormError(message);
      toast({ title: editing ? "Changes not saved" : "Product not added", description: message, tone: "error" });
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} aria-describedby={formError ? ids.form : undefined} className="space-y-5">
      {formError ? <FormAlert id={ids.form}>{formError}</FormAlert> : null}

      {editing ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">
          <span className="font-medium">{KIND_LABEL[product.kind]}</span> — the kind is fixed once a product is created.
        </p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Kind</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["GOOD", "SERVICE"] as const satisfies readonly ProductKind[]).map((value) => (
              <label key={value} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                <input type="radio" value={value} className="mt-0.5 size-4 accent-primary" {...register("kind")} />
                <span>
                  <span className="block font-medium">{KIND_LABEL[value]}</span>
                  <span className="text-muted-foreground">{value === "GOOD" ? "Stocked: received, held and counted." : "Not stocked, e.g. delivery or labour."}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <TextField id={ids.sku} label="SKU" autoComplete="off" spellCheck={false} data-autofocus error={errors.sku?.message} {...register("sku")} />
        <TextField id={ids.name} label="Name" autoComplete="off" error={errors.name?.message} {...register("name")} />
        <TextField id={ids.price} label="Selling price (KES)" inputMode="decimal" autoComplete="off" hint="Before VAT." error={errors.price?.message} {...register("price")} />
        <TextField id={ids.cost} label="Cost price (KES)" inputMode="decimal" autoComplete="off" hint="Your usual purchase cost." error={errors.costPrice?.message} {...register("costPrice")} />
        <TextField id={ids.unit} label="Unit of measure" autoComplete="off" error={errors.unitOfMeasure?.message} {...register("unitOfMeasure")} />
        <TextField id={ids.barcode} label="Barcode" optional autoComplete="off" spellCheck={false} error={errors.barcode?.message} {...register("barcode")} />
        <div className="sm:col-span-2">
          <TextField id={ids.category} label="Category" optional autoComplete="off" list={ids.categories} hint="Pick an existing one or type a new one." error={errors.category?.message} {...register("category")} />
          <datalist id={ids.categories}>
            {categories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
        </div>
      </div>

      {!editing ? (
        canSetTaxClass ? (
          <div className="space-y-2">
            <Label htmlFor={ids.tax}>Tax class</Label>
            <select id={ids.tax} className={SELECT_CLASS} {...register("taxClass")}>
              {TAX_CLASSES.map((value: TaxClass) => (
                <option key={value} value={value}>
                  {TAX_CLASS_LABEL[value]}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Tax class: Standard-rated. An owner or manager can change it.</p>
        )
      ) : null}

      {!editing ? (
        <p className="flex gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          {kind === "SERVICE"
            ? "Services carry no stock — they are sold without counting anything out."
            : "A new product starts with zero stock. Add stock through Inventory — a goods receipt or an opening balance."}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" className="h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="h-11" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : editing ? "Save changes" : "Add product"}
        </Button>
      </div>
    </form>
  );
}
