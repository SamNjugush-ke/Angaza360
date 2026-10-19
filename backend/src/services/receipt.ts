// ===========================================================================
// Receipt builder (Task 3.2; fiscal block filled in by Task 4.1). Produces a
// structured JSON receipt the frontend renders. No PDF, no thermal formatting
// here.
//
// The eTIMS block is no longer a seam: it now reports the sale's real fiscal
// status and, when KRA signed the sale, KRA's own receipt number, signature and
// verification QR. For the ordinary unsigned sale — most of them — the status is
// NOT_REQUESTED and every artifact is null, which is the truthful receipt for a
// sale that was never filed.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { Cents } from "../lib/money";
import type {
  KraTaxCode,
  PaymentStatus,
  SaleFiscalStatus,
  SaleStatus,
  TenderType,
} from "../generated/tenant/enums";
import { kraTaxCodeLabel } from "../lib/vat";
import { getSale, type SaleLineResult } from "./sales";
import { getBusinessProfile } from "./business-profile";
import { platformDb } from "../db/platform";
import { getSignedInvoiceForSale } from "./etims/etims-signing";

export interface ReceiptBusinessHeader {
  name: string;
  subdomain: string;
  kraPin: string | null;
}

/**
 * The header a receipt PRINTS (Task T-A13): the caller's identity plus the business's own
 * receipt settings (business profile) and branding (its own registry row). The KRA PIN is
 * the business profile's when set — the business's own, edited in its settings — and the
 * registry's otherwise.
 */
export interface PrintedBusinessHeader extends ReceiptBusinessHeader {
  legalName: string | null;
  addressLine: string | null;
  phone: string | null;
  email: string | null;
  brandPrimaryColor: string | null;
  logoUrl: string | null;
}

export interface ReceiptLine {
  description: string;
  quantity: string;
  unitPrice: Cents;
  discount: Cents;
  vatRate: string;
  taxCode: KraTaxCode;
  lineNet: Cents;
  lineVat: Cents;
  lineTotal: Cents;
}

/** One row of the receipt's VAT breakdown, as on a Kenyan fiscal receipt. */
export interface TaxCodeSummaryRow {
  code: KraTaxCode;
  label: string;
  rate: string;
  vatableAmount: Cents;
  vatAmount: Cents;
}

export interface Receipt {
  business: PrintedBusinessHeader;
  /** The business's receipt footer, or null. */
  footer: string | null;
  saleNumber: string;
  timestamp: Date;
  status: SaleStatus;
  lines: ReceiptLine[];
  vatSummary: { subtotal: Cents; vatTotal: Cents; total: Cents };
  /** By KRA tax code: B, C, A, then D. A non-registered seller's sale is one D row. */
  taxCodeSummary: TaxCodeSummaryRow[];
  tenders: Array<{ tenderType: TenderType; amount: Cents; status: PaymentStatus }>;
  amountTendered: Cents;
  changeDue: Cents; // for cash; 0 when tenders match the total exactly
  customer: { name: string; loyaltyPoints: number } | null;
  /**
   * KRA FISCAL BLOCK (Module 9, Task 4.1). What a receipt must show when — and
   * only when — the sale was fiscally signed.
   *
   * For the ORDINARY sale, fiscalStatus is NOT_REQUESTED and every artifact is
   * null. That is not a missing feature: most MSME sales carry no buyer PIN and
   * are validly finalized with no KRA invoice at all, and printing a fiscal block
   * on one would misrepresent it as filed.
   *
   * The artifacts here are KRA's own and are reproduced verbatim: the receipt
   * number a buyer quotes, the signature, and the QR a buyer scans to verify the
   * invoice on KRA's portal.
   */
  etims: {
    fiscalStatus: SaleFiscalStatus;
    invoiceNumber: string | null;
    kraReceiptNumber: string | null;
    rcptSign: string | null;
    intrlData: string | null;
    sdcDateTime: string | null;
    qrCode: string | null;
  };
}

export async function buildReceipt(
  db: TenantPrismaClient,
  saleId: string,
  business: ReceiptBusinessHeader,
): Promise<Receipt | null> {
  const sale = await getSale(db, saleId);
  if (sale === null) {
    return null;
  }

  let customer: { name: string; loyaltyPoints: number } | null = null;
  if (sale.customerId !== null) {
    const record = await db.customer.findUnique({ where: { id: sale.customerId } });
    if (record !== null) {
      customer = { name: record.name, loyaltyPoints: record.loyaltyPoints };
    }
  }

  let amountTendered = 0n;
  for (const tender of sale.tenders) {
    amountTendered += tender.amount;
  }

  // The receipt reflects the business's settings: its profile (this tenant's schema) and
  // its branding (its own registry row, found by the caller's subdomain).
  const profile = await getBusinessProfile(db);
  const branding = await platformDb.tenant.findUnique({
    where: { subdomain: business.subdomain },
    select: { brandPrimaryColor: true, brandLogoUrl: true },
  });
  const printed: PrintedBusinessHeader = {
    ...business,
    kraPin: profile.kraPin ?? business.kraPin,
    legalName: profile.legalName,
    addressLine: profile.addressLine,
    phone: profile.phone,
    email: profile.email,
    brandPrimaryColor: branding?.brandPrimaryColor ?? null,
    logoUrl: profile.showLogoOnReceipt ? (branding?.brandLogoUrl ?? null) : null,
  };

  return {
    business: printed,
    footer: profile.receiptFooter,
    saleNumber: sale.saleNumber,
    timestamp: sale.createdAt,
    status: sale.status,
    lines: sale.lines.map((line) => ({
      description: `${line.name} (${line.sku})`,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discount: line.discount,
      vatRate: line.vatRate,
      taxCode: line.taxCode,
      lineNet: line.lineNet,
      lineVat: line.lineVat,
      lineTotal: line.lineTotal,
    })),
    vatSummary: { subtotal: sale.subtotal, vatTotal: sale.vatTotal, total: sale.total },
    taxCodeSummary: taxCodeSummaryOf(sale.saleNumber, sale.lines, sale.vatTotal),
    tenders: sale.tenders.map((tender) => ({
      tenderType: tender.tenderType,
      amount: tender.amount,
      status: tender.status,
    })),
    amountTendered,
    changeDue: amountTendered - sale.total,
    customer,
    etims: await buildFiscalBlock(db, sale.id, sale.fiscalStatus),
  };
}

const CODE_ORDER: readonly KraTaxCode[] = ["B", "C", "A", "D"];

/**
 * THE VAT-CODE SUMMARY (Task 3B.1): Σ lineNet and Σ lineVat per KRA tax code, read
 * from the code each line was CHARGED under — never re-derived from the product's
 * current class, which may have changed since. A pre-3B.1 line reads as B, exactly as
 * it was charged (see src/lib/vat.ts).
 *
 * The VAT column must sum to the sale's VAT total; a receipt that disagreed with the
 * sale it prints would be a defect, so it is asserted rather than displayed.
 */
function taxCodeSummaryOf(
  saleNumber: string,
  lines: ReadonlyArray<SaleLineResult>,
  vatTotal: Cents,
): TaxCodeSummaryRow[] {
  const byCode = new Map<KraTaxCode, TaxCodeSummaryRow>();
  for (const line of lines) {
    const row = byCode.get(line.taxCode) ?? {
      code: line.taxCode,
      label: kraTaxCodeLabel(line.taxCode),
      rate: line.vatRate,
      vatableAmount: 0n,
      vatAmount: 0n,
    };
    row.vatableAmount += line.lineNet;
    row.vatAmount += line.lineVat;
    byCode.set(line.taxCode, row);
  }
  const rows = CODE_ORDER.flatMap((code) => {
    const row = byCode.get(code);
    return row === undefined ? [] : [row];
  });
  const summed = rows.reduce((sum, row) => sum + row.vatAmount, 0n);
  if (summed !== vatTotal) {
    throw new Error(
      `Receipt for ${saleNumber}: the VAT-code summary totals ${summed.toString()} cents but the sale's VAT is ${vatTotal.toString()} cents. Refusing to print a receipt that disagrees with its sale.`,
    );
  }
  return rows;
}

/**
 * Read the sale's fiscal artifacts for the receipt.
 *
 * Short-circuits on the common case — a NOT_REQUESTED sale needs no query at all,
 * and that is the great majority of receipts, so the fiscal block costs nothing
 * for the sales that do not use it.
 *
 * A non-SIGNED invoice (queued or rejected) deliberately returns NO artifacts: it
 * has none, and a receipt must never imply an invoice was filed when it was not.
 * The status itself is reported, so a cashier can see a KRA invoice is still
 * pending rather than silently handing over a receipt that looks unfiled.
 */
async function buildFiscalBlock(
  db: TenantPrismaClient,
  saleId: string,
  fiscalStatus: SaleFiscalStatus,
): Promise<Receipt["etims"]> {
  const empty = {
    fiscalStatus,
    invoiceNumber: null,
    kraReceiptNumber: null,
    rcptSign: null,
    intrlData: null,
    sdcDateTime: null,
    qrCode: null,
  };
  if (fiscalStatus === "NOT_REQUESTED") {
    return empty;
  }

  const invoice = await getSignedInvoiceForSale(db, saleId);
  if (invoice === null || invoice.status !== "SIGNED") {
    return empty;
  }
  return {
    fiscalStatus,
    invoiceNumber: invoice.etimsInvoiceNumber.toString(),
    kraReceiptNumber: invoice.kraReceiptNumber,
    rcptSign: invoice.rcptSign,
    intrlData: invoice.intrlData,
    sdcDateTime: invoice.sdcDateTime,
    qrCode: invoice.qrCodeUrl,
  };
}
