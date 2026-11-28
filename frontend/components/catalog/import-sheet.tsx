"use client";

import { CheckCircle2, Download, FileWarning } from "lucide-react";
import { useId, useState } from "react";
import { FormAlert } from "@/components/auth/form-bits";
import { useToast } from "@/components/toast/toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sheet } from "@/components/ui/sheet";
import { commitImport, fetchImportTemplate, previewImport } from "@/lib/catalog/api";
import { useInvalidateCatalog } from "@/lib/catalog/hooks";
import type { ImportCommit, ImportPreview, ImportPreviewRow } from "@/lib/catalog/types";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { parseCents } from "@/lib/money";

// Importing a product list from a spreadsheet: download the template, choose the filled-in CSV,
// CHECK it (the server previews every row and writes nothing), and import only when every row is
// ready — the backend refuses a file with any row in error, so nothing half-imports. The chosen
// file is kept through every failure: fix the spreadsheet, choose it again or simply re-check.

/** The CSV columns as people read them. */
export const COLUMN_LABEL: Readonly<Record<string, string>> = {
  sku: "SKU",
  name: "Name",
  category: "Category",
  unitOfMeasure: "Unit of measure",
  kind: "Kind",
  taxClass: "Tax class",
  costPrice: "Cost price",
  price: "Selling price",
  barcode: "Barcode",
  openingQty: "Opening quantity",
  openingUnitCost: "Opening unit cost",
};

const messageOf = (error: unknown, fallback: string) => (error instanceof ApiHttpError ? error.message : fallback);

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function RowProblems({ rows }: { rows: readonly ImportPreviewRow[] }) {
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.rowNumber} className="rounded-md border border-destructive/40 p-3 text-sm">
          <p className="font-medium">
            Row {row.rowNumber.toString()}
            {row.sku || row.name ? <span className="font-normal text-muted-foreground"> · {[row.sku, row.name].filter(Boolean).join(" · ")}</span> : null}
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {row.errors.map((error, index) => (
              <li key={`${error.field}-${index.toString()}`}>
                <span className="font-medium">{COLUMN_LABEL[error.field] ?? error.field}:</span> {error.message}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function ImportSheet({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateCatalog();
  const ids = { file: useId(), error: useId() };
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportCommit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"template" | "check" | "import" | null>(null);

  async function downloadTemplate() {
    setBusy("template");
    try {
      saveFile("product-import-template.csv", await fetchImportTemplate());
    } catch (failure) {
      toast({ title: "Template not downloaded", description: messageOf(failure, "Please try again."), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function check() {
    if (!file) return;
    setBusy("check");
    setError(null);
    setPreview(null);
    try {
      setPreview(await previewImport(await file.text()));
    } catch (failure) {
      setError(messageOf(failure, "The file could not be read. If you changed it since choosing it, choose it again."));
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!file) return;
    setBusy("import");
    setError(null);
    try {
      const committed = await commitImport(await file.text());
      setResult(committed);
      await invalidate();
      toast({ title: `Imported ${committed.created.length.toString()} products`, tone: "success" });
    } catch (failure) {
      // The file is kept; a 409 means the catalog changed since the check (e.g. a SKU now exists).
      setPreview(null);
      setError(
        failure instanceof ApiHttpError && failure.status === 409
          ? `${failure.message} Check the file again to see what changed.`
          : messageOf(failure, "The import did not complete. Nothing was imported — please try again."),
      );
      toast({ title: "Nothing was imported", description: messageOf(failure, "Please try again."), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  if (result) {
    const goods = result.created.filter((row) => row.kind === "GOOD").length;
    const withStock = result.created.filter((row) => parseCents(row.openingStockValue) > 0n).length;
    return (
      <Sheet title="Import complete" onClose={onClose}>
        <div role="status" className="space-y-4">
          <p className="flex items-start gap-3 text-base font-medium">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            {`Imported ${result.created.length.toString()} products — ${goods.toString()} goods and ${(result.created.length - goods).toString()} services.`}
          </p>
          <p className="text-sm text-muted-foreground">
            {withStock > 0 ? `${withStock.toString()} started with opening stock, recorded in your inventory and books.` : "None had opening stock; add stock through Inventory."}
          </p>
          <Button type="button" className="h-11" onClick={onClose} data-autofocus>
            Done
          </Button>
        </div>
      </Sheet>
    );
  }

  const problems = preview?.rows.filter((row) => row.status !== "GREEN") ?? [];
  const ready = (preview?.rows.length ?? 0) - problems.length;

  return (
    <Sheet
      wide
      title="Import products"
      description="Add many products at once from a spreadsheet saved as CSV. Nothing is imported until every row is ready."
      onClose={onClose}
    >
      <div className="space-y-6">
        <section className="space-y-2">
          <h3 className="font-display text-base font-semibold">1. Get the template</h3>
          <p className="text-sm text-muted-foreground">
            Required columns: SKU, name, cost price and selling price. Optional: category, unit, kind (GOOD or SERVICE), tax class, barcode,
            and an opening quantity — the one way a product can start with stock already on hand (goods only).
          </p>
          <Button type="button" variant="outline" className="h-11" disabled={busy === "template"} onClick={() => void downloadTemplate()}>
            <Download aria-hidden /> {busy === "template" ? "Preparing…" : "Download template"}
          </Button>
        </section>

        <section className="space-y-3">
          <h3 className="font-display text-base font-semibold">2. Choose your file and check it</h3>
          <div className="space-y-2">
            <Label htmlFor={ids.file}>CSV file</Label>
            <input
              id={ids.file}
              type="file"
              accept=".csv,text/csv"
              aria-describedby={error ? ids.error : undefined}
              className="block min-h-11 w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-input file:bg-background file:px-4 file:font-medium"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setPreview(null);
                setError(null);
              }}
            />
            {file ? <p className="text-sm text-muted-foreground">Chosen: {file.name}</p> : null}
          </div>
          <Button type="button" className="h-11" disabled={!file || busy !== null} onClick={() => void check()}>
            {busy === "check" ? "Checking…" : preview || error ? "Check again" : "Check file"}
          </Button>
          {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
        </section>

        {preview ? (
          <section className="space-y-4" aria-live="polite">
            <h3 className="font-display text-base font-semibold">3. Review and import</h3>
            <p role="status" className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
              {preview.allGreen ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /> : <FileWarning className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />}
              {`${preview.rows.length.toString()} rows checked — ${ready.toString()} ready, ${problems.length.toString()} need fixing.`}
            </p>
            {preview.allGreen ? (
              <Button type="button" className="h-11" disabled={busy !== null} onClick={() => void runImport()}>
                {busy === "import" ? "Importing…" : `Import ${preview.rows.length.toString()} products`}
              </Button>
            ) : (
              <>
                <p className="text-sm">Fix these rows in your spreadsheet, save it as CSV, then check the file again. Your chosen file stays selected.</p>
                <RowProblems rows={problems} />
              </>
            )}
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
