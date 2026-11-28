// ===========================================================================
// KRA eTIMS FISCAL SIGNING (Module 9, Task 4.1).
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE `etims_devices` OR `etims_invoices`,
// AND THE ONLY MODULE PERMITTED TO CHANGE `Sale.fiscalStatus`.
//
// WHAT IT NEVER DOES, and these are the load-bearing negatives:
//   * It NEVER writes a journal table and NEVER posts to the ledger. eTIMS is a
//     FISCAL ATTESTATION, not a financial event: the VAT was already posted at
//     sale time by the POS flow (Cr 2100 VAT Output Payable), and posting
//     anything here would double-count the tax.
//   * It NEVER writes a stock table and never touches inventory.
//   * It NEVER ROLLS BACK OR ALTERS A COMMITTED SALE. Signing runs POST-COMMIT on
//     a sale that is already final. The ONLY field it may change on a sale is
//     fiscalStatus; the sale immutability guard (migration 0016) enforces that
//     even against a bug in this file.
//   * It NEVER logs, persists or returns the cmcKey or the authToken.
//
// WHY POST-COMMIT MATTERS MORE THAN IT LOOKS: if signing were inside the sale
// transaction, a KRA outage would roll back a sale the customer has already paid
// for and walked away with. The customer's goods are gone; the sale must stand.
// So the sale commits first, always, and the fiscal invoice is a separate record
// that may lag, fail, or be fixed later without ever touching the books.
//
// ---------------------------------------------------------------------------
// THE NO-DOUBLE-FILE RULE, which is the one thing that must never break
//
// An invoice number is ALLOCATED BEFORE SUBMISSION and REUSED ON EVERY RETRY.
// Never reallocated. If a submission times out we do not know whether KRA saw it,
// so resubmitting the SAME number is safe in both cases: if KRA never saw it, it
// files; if KRA did see it, KRA rejects the duplicate number and we learn the
// truth. Taking a FRESH number would file the same sale twice under two numbers,
// which overstates the tenant's declared revenue to the Kenya Revenue Authority
// and cannot be undone by anything short of a credit note and an explanation.
//
// Migration 0016 freezes etimsInvoiceNumber from the moment of allocation, so the
// rule survives a bug here.
// ---------------------------------------------------------------------------
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import type {
  EtimsInvoiceStatus,
  EtimsInvoiceType,
  SaleFiscalStatus,
} from "../../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../../db/tenant";
import type { Cents } from "../../lib/money";
import { effectiveLineTax } from "../../lib/vat";
import type { LedgerTx } from "../ledger";
import {
  mergeCredentialFields,
  NoActiveCredentialError,
} from "../credentials/credential-store";
import { ETIMS_CMC_KEY_FIELD } from "../credentials/provider-schemas";
import { getEtimsProviderForTenant, type ResolvedEtimsProvider } from "./factory";
import {
  EtimsInitError,
  type EtimsInvoiceLine,
  type EtimsSignRequest,
  type EtimsSignResult,
} from "./provider";

/** Bad input, or an unsignable state (unknown sale, voided sale). Route -> 400. */
export class EtimsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtimsValidationError";
  }
}

/** The tenant cannot sign: no credentials, or the device is not initialized. Route -> 400. */
export class EtimsNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtimsNotConfiguredError";
  }
}

/** The invoice's current state forbids the operation (already signed). Route -> 409. */
export class EtimsStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtimsStateError";
  }
}

/**
 * How many connectivity retries an invoice gets before it is parked as FAILED for
 * an operator. Not unlimited: an invoice that has been unreachable this many times
 * has a cause a retry will not fix (a wrong endpoint, a revoked device), and a
 * queue that retries forever is a queue nobody ever looks at.
 */
const MAX_RETRY_ATTEMPTS = 5;

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface EtimsDeviceRow {
  id: string;
  tin: string;
  bhfId: string;
  dvcSrlNo: string;
  initialized: boolean;
  lastInitAt: Date | null;
  lastInvoiceNo: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EtimsInvoiceRow {
  id: string;
  saleId: string;
  saleNumber: string;
  invoiceType: EtimsInvoiceType;
  originalInvoiceId: string | null;
  etimsDeviceId: string;
  etimsInvoiceNumber: number;
  status: EtimsInvoiceStatus;
  kraReceiptNumber: string | null;
  rcptSign: string | null;
  intrlData: string | null;
  sdcDateTime: string | null;
  qrCodeUrl: string | null;
  resultCode: string | null;
  resultMsg: string | null;
  retryCount: number;
  lastAttemptAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const INVOICE_INCLUDE = { sale: { select: { saleNumber: true } } } as const;

interface RawInvoice {
  id: string;
  saleId: string;
  invoiceType: EtimsInvoiceType;
  originalInvoiceId: string | null;
  etimsDeviceId: string;
  etimsInvoiceNumber: number;
  status: EtimsInvoiceStatus;
  kraReceiptNumber: string | null;
  rcptSign: string | null;
  intrlData: string | null;
  sdcDateTime: string | null;
  qrCodeUrl: string | null;
  resultCode: string | null;
  resultMsg: string | null;
  retryCount: number;
  lastAttemptAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  sale: { saleNumber: string };
}

function toInvoiceRow(invoice: RawInvoice): EtimsInvoiceRow {
  return {
    id: invoice.id,
    saleId: invoice.saleId,
    saleNumber: invoice.sale.saleNumber,
    invoiceType: invoice.invoiceType,
    originalInvoiceId: invoice.originalInvoiceId,
    etimsDeviceId: invoice.etimsDeviceId,
    etimsInvoiceNumber: invoice.etimsInvoiceNumber,
    status: invoice.status,
    kraReceiptNumber: invoice.kraReceiptNumber,
    rcptSign: invoice.rcptSign,
    intrlData: invoice.intrlData,
    sdcDateTime: invoice.sdcDateTime,
    qrCodeUrl: invoice.qrCodeUrl,
    resultCode: invoice.resultCode,
    resultMsg: invoice.resultMsg,
    retryCount: invoice.retryCount,
    lastAttemptAt: invoice.lastAttemptAt,
    createdBy: invoice.createdBy,
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// 1. DEVICE INITIALIZATION — stateful, occasional, never per sale
// ---------------------------------------------------------------------------

export interface InitializeDeviceResult {
  device: EtimsDeviceRow;
  /** Whether this call obtained a NEW key, or confirmed one already held. */
  keyStored: boolean;
  environment: string;
  providerName: string;
}

/**
 * Initialize the tenant's OSCU device with KRA.
 *
 * KRA's selectInitOsdcInfo(tin, bhfId, dvcSrlNo) returns a cmcKey — the
 * communication key that must accompany every later request. This is STATEFUL and
 * OCCASIONAL: run at setup, or when a key expires. It is never part of signing a
 * sale.
 *
 * THE KEY IS WRITTEN BACK INTO THE ENCRYPTED CREDENTIAL BLOB, not into a column.
 * It is a secret, and the credential store is where this system keeps secrets —
 * so it goes through mergeCredentialFields, which re-encrypts the blob in place
 * and deliberately does NOT reset the credential to PENDING (a rotation would,
 * and would deactivate the very credential it just initialized).
 *
 * The key is never returned by this function, never logged, and the raw KRA
 * response is NOT persisted here precisely because it echoes the key.
 */
export async function initializeDevice(
  db: TenantPrismaClient,
  createdBy: string,
): Promise<InitializeDeviceResult> {
  // requireEnabled is deliberately NOT set: an owner must be able to initialize
  // the device before switching the integration on.
  const resolved = await resolveProvider(db);
  const { credentials, provider } = resolved;

  let cmcKey: string;
  try {
    const result = await provider.initializeDevice(credentials);
    cmcKey = result.cmcKey;
  } catch (error) {
    if (error instanceof EtimsInitError) {
      throw new EtimsNotConfiguredError(error.message);
    }
    throw error;
  }

  // Store the key back into the tenant's own encrypted blob. If this throws,
  // nothing is marked initialized — a device recorded as initialized without a
  // stored key would fail every later signature with a confusing error.
  await mergeCredentialFields(db, "ETIMS", resolved.environment, {
    [ETIMS_CMC_KEY_FIELD]: cmcKey,
  });

  const now = new Date();
  const device = await db.etimsDevice.upsert({
    where: {
      tin_bhfId_dvcSrlNo: {
        tin: credentials.tin,
        bhfId: credentials.bhfId,
        dvcSrlNo: credentials.dvcSrlNo,
      },
    },
    create: {
      tin: credentials.tin,
      bhfId: credentials.bhfId,
      dvcSrlNo: credentials.dvcSrlNo,
      initialized: true,
      lastInitAt: now,
      createdBy,
    },
    update: {
      initialized: true,
      lastInitAt: now,
      // lastInvoiceNo is deliberately NOT reset. Re-initializing a device (a key
      // rotation) does not restart KRA's numbering, and resetting the counter
      // would re-issue numbers KRA has already seen.
    },
  });

  return {
    device,
    keyStored: true,
    environment: resolved.environment,
    providerName: provider.name,
  };
}

export async function getDevice(db: TenantPrismaClient): Promise<EtimsDeviceRow | null> {
  // There is at most one device per tenant in practice (one TIN, one branch, one
  // serial), so the newest row is the device. The unique on (tin,bhfId,dvcSrlNo)
  // is what makes "newest" unambiguous rather than arbitrary.
  const device = await db.etimsDevice.findFirst({ orderBy: { createdAt: "desc" } });
  return device;
}

// ---------------------------------------------------------------------------
// 2. SIGNING A SALE INVOICE — the core
// ---------------------------------------------------------------------------

export interface SignSaleResult {
  invoice: EtimsInvoiceRow;
  /** The resulting sale fiscal status, so a caller can report it without re-reading. */
  fiscalStatus: SaleFiscalStatus;
  /** true when this call found an already-SIGNED invoice and did nothing. */
  alreadySigned: boolean;
  providerName: string;
}

/**
 * Sign one sale with KRA. The single signing path in the system: the online POS
 * route and the OFF.1 sync ingest both call THIS, so there is exactly one place
 * that allocates a number, submits, and maps an outcome.
 *
 * IDEMPOTENT: a sale that already has a SIGNED invoice returns it untouched. A
 * sale is filed with KRA once; filing it twice would double-report revenue, and
 * the partial unique index in 0016 backstops this.
 */
export async function signSaleInvoice(
  db: TenantPrismaClient,
  saleId: string,
  createdBy: string,
): Promise<SignSaleResult> {
  const schema = resolveSchema(db);

  // (1) IDEMPOTENCY FIRST, before any provider work or credential decryption.
  const existing = await db.etimsInvoice.findFirst({
    where: { saleId, invoiceType: "SALE" },
    include: INVOICE_INCLUDE,
  });
  if (existing !== null && existing.status === "SIGNED") {
    return {
      invoice: toInvoiceRow(existing),
      fiscalStatus: "SIGNED",
      alreadySigned: true,
      providerName: "n/a",
    };
  }

  // (2) The sale must exist and be signable.
  const sale = await loadSaleForSigning(db, saleId);

  // (3) The tenant must be able to sign. requireEnabled: signing a sale is the
  // operational path, so the integration must actually be switched on.
  const resolved = await resolveProvider(db, { requireEnabled: true });
  const device = await requireInitializedDevice(db, resolved);

  // (4) Reuse the number already allocated to this sale, or allocate one. This is
  // the no-double-file rule in code.
  const invoice =
    existing !== null
      ? existing
      : await allocateInvoice(db, schema, {
          saleId,
          invoiceType: "SALE",
          originalInvoiceId: null,
          deviceId: device.id,
          createdBy,
        });

  if (invoice.status === "REJECTED" || invoice.status === "FAILED") {
    // A deliberate operator resubmission after a fix. Permitted — but it keeps the
    // same number, like every other resubmission.
    // (Falls through to submission below.)
  }

  const request = buildSignRequest(invoice.etimsInvoiceNumber, "SALE", null, sale, null);
  const result = await resolved.provider.signInvoice(request, resolved.credentials);

  const persisted = await persistOutcome(db, invoice.id, saleId, result, invoice.retryCount);
  return {
    invoice: persisted.invoice,
    fiscalStatus: persisted.fiscalStatus,
    alreadySigned: false,
    providerName: resolved.provider.name,
  };
}

// ---------------------------------------------------------------------------
// 3. CREDIT NOTES — the fiscal reversal of a SIGNED sale
// ---------------------------------------------------------------------------

export interface CreditNoteResult {
  invoice: EtimsInvoiceRow;
  providerName: string;
}

/**
 * Record, and submit, the CREDIT NOTE that reverses a SIGNED sale invoice.
 *
 * KRA requires the reversal of a filed invoice to come from the SAME solution that
 * filed it, referencing the original invoice. A signed sale that is voided and
 * left with no fiscal reversal is a declared sale the business did not make — so
 * the obligation is always RECORDED (see recordCreditNoteObligation, called by the
 * void path) and this function is what discharges it.
 *
 * Refused unless the original SALE invoice is SIGNED: there is nothing to reverse
 * if KRA never accepted the sale, and filing a credit note against an unsigned
 * invoice would be a reversal of something KRA has no record of.
 */
export async function signCreditNote(
  db: TenantPrismaClient,
  saleId: string,
  reason: string,
  createdBy: string,
): Promise<CreditNoteResult> {
  const schema = resolveSchema(db);
  const trimmedReason = reason.trim();
  if (trimmedReason === "") {
    throw new EtimsValidationError("reason is required on a credit note: KRA records why.");
  }

  const original = await db.etimsInvoice.findFirst({
    where: { saleId, invoiceType: "SALE" },
    include: INVOICE_INCLUDE,
  });
  if (original === null) {
    throw new EtimsValidationError(
      `Sale ${saleId} has no eTIMS sale invoice, so there is nothing to reverse with a credit note.`,
    );
  }
  if (original.status !== "SIGNED") {
    throw new EtimsStateError(
      `Sale ${saleId}'s eTIMS invoice is ${original.status}, not SIGNED. A credit note reverses a FILED invoice; an unsigned one is corrected by fixing and resubmitting it, not by reversing it.`,
    );
  }

  const sale = await loadSaleForSigning(db, saleId, { allowVoided: true });
  const resolved = await resolveProvider(db, { requireEnabled: true });
  const device = await requireInitializedDevice(db, resolved);

  // An existing unsigned credit note keeps its number (the no-double-file rule
  // applies to credit notes exactly as it does to sales).
  const pending = await db.etimsInvoice.findFirst({
    where: { saleId, invoiceType: "CREDIT_NOTE", status: { in: ["PENDING", "QUEUED", "REJECTED", "FAILED"] } },
    include: INVOICE_INCLUDE,
    orderBy: { createdAt: "asc" },
  });
  const invoice =
    pending ??
    (await allocateInvoice(db, schema, {
      saleId,
      invoiceType: "CREDIT_NOTE",
      originalInvoiceId: original.id,
      deviceId: device.id,
      createdBy,
    }));

  const request = buildSignRequest(
    invoice.etimsInvoiceNumber,
    "CREDIT_NOTE",
    original.etimsInvoiceNumber,
    sale,
    trimmedReason,
  );
  const result = await resolved.provider.signInvoice(request, resolved.credentials);

  // A credit note's outcome must NOT move Sale.fiscalStatus: the sale IS signed,
  // permanently, and the trigger in 0016 refuses to downgrade it. The reversal is
  // its own fiscal record.
  const persisted = await persistOutcome(db, invoice.id, saleId, result, invoice.retryCount, {
    touchSaleFiscalStatus: false,
  });
  return { invoice: persisted.invoice, providerName: resolved.provider.name };
}

/**
 * Record — WITHOUT submitting — that a voided sale owes KRA a credit note.
 *
 * Called by the void path INSIDE the void's own transaction, so a signed sale can
 * never be voided without the fiscal obligation being written down in the same
 * atomic step. Submission is a separate act (POST /v1/etims/invoices/:id/retry,
 * or the retry sweep), because a void must never depend on KRA being reachable:
 * the customer is standing at the counter and the refund cannot wait on a network.
 *
 * Returns null when the sale has no SIGNED invoice — the overwhelmingly common
 * case, since most sales are never filed at all. Nothing is recorded then, because
 * nothing is owed.
 */
export async function recordCreditNoteObligationWithinTransaction(
  tx: LedgerTx,
  schema: string,
  saleId: string,
  reason: string,
  createdBy: string,
): Promise<{ invoiceId: string; etimsInvoiceNumber: number } | null> {
  assertValidSchemaName(schema);

  const original = await tx.etimsInvoice.findFirst({
    where: { saleId, invoiceType: "SALE", status: "SIGNED" },
  });
  if (original === null) {
    return null;
  }

  // Already recorded (a second void attempt, or a prior obligation). Never a
  // second obligation for the same reversal.
  const existing = await tx.etimsInvoice.findFirst({
    where: { saleId, invoiceType: "CREDIT_NOTE" },
  });
  if (existing !== null) {
    return { invoiceId: existing.id, etimsInvoiceNumber: existing.etimsInvoiceNumber };
  }

  const number = await allocateInvoiceNumberWithinTransaction(tx, schema, original.etimsDeviceId);
  const created = await tx.etimsInvoice.create({
    data: {
      saleId,
      invoiceType: "CREDIT_NOTE",
      originalInvoiceId: original.id,
      etimsDeviceId: original.etimsDeviceId,
      etimsInvoiceNumber: number,
      status: "PENDING",
      resultMsg: `Credit note owed: sale voided (${reason}). Not yet submitted to KRA.`,
      createdBy,
    },
  });
  return { invoiceId: created.id, etimsInvoiceNumber: created.etimsInvoiceNumber };
}

// ---------------------------------------------------------------------------
// 4. THE RETRY SWEEP — connectivity failures only, same numbers
// ---------------------------------------------------------------------------

export interface RetryOutcomeRow {
  invoiceId: string;
  etimsInvoiceNumber: number;
  saleNumber: string;
  previousStatus: EtimsInvoiceStatus;
  status: EtimsInvoiceStatus;
  retryCount: number;
  resultMsg: string | null;
}

export interface RetryResult {
  attempted: number;
  signed: number;
  rejected: number;
  stillQueued: number;
  exhausted: number;
  rows: RetryOutcomeRow[];
}

/**
 * Resubmit QUEUED invoices — the connectivity backlog — each WITH THE NUMBER IT
 * ALREADY HOLDS.
 *
 * REJECTED invoices are deliberately NOT swept. KRA was reachable and refused
 * them: the payload is wrong, and resubmitting it unchanged just gets refused
 * again while burying the real problem under a retry count. Those need an operator,
 * which is what the failed-invoice dashboard is for.
 */
export async function retryQueuedInvoices(
  db: TenantPrismaClient,
  olderThanMinutes: number,
): Promise<RetryResult> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const queued = await db.etimsInvoice.findMany({
    where: {
      status: "QUEUED",
      OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: cutoff } }],
    },
    include: INVOICE_INCLUDE,
    orderBy: { etimsInvoiceNumber: "asc" },
  });

  const rows: RetryOutcomeRow[] = [];
  let signed = 0;
  let rejected = 0;
  let stillQueued = 0;
  let exhausted = 0;

  if (queued.length === 0) {
    return { attempted: 0, signed, rejected, stillQueued, exhausted, rows };
  }

  // Resolved ONCE for the sweep: every invoice in a tenant belongs to the same
  // tenant's device and credentials.
  const resolved = await resolveProvider(db, { requireEnabled: true });

  for (const invoice of queued) {
    const sale = await loadSaleForSigning(db, invoice.saleId, { allowVoided: true });

    let originalNumber: number | null = null;
    if (invoice.invoiceType === "CREDIT_NOTE" && invoice.originalInvoiceId !== null) {
      const original = await db.etimsInvoice.findUnique({
        where: { id: invoice.originalInvoiceId },
        select: { etimsInvoiceNumber: true },
      });
      originalNumber = original?.etimsInvoiceNumber ?? null;
    }

    const request = buildSignRequest(
      // THE SAME NUMBER. Never reallocated — see the no-double-file note above.
      invoice.etimsInvoiceNumber,
      invoice.invoiceType,
      originalNumber,
      sale,
      invoice.invoiceType === "CREDIT_NOTE" ? (invoice.resultMsg ?? "Credit note") : null,
    );
    const result = await resolved.provider.signInvoice(request, resolved.credentials);

    const nextRetryCount = invoice.retryCount + 1;
    const persisted = await persistOutcome(
      db,
      invoice.id,
      invoice.saleId,
      result,
      nextRetryCount,
      {
        touchSaleFiscalStatus: invoice.invoiceType === "SALE",
        exhaustRetries: result.outcome === "CONNECTIVITY_FAILURE" && nextRetryCount >= MAX_RETRY_ATTEMPTS,
      },
    );

    if (persisted.invoice.status === "SIGNED") {
      signed += 1;
    } else if (persisted.invoice.status === "REJECTED") {
      rejected += 1;
    } else if (persisted.invoice.status === "FAILED") {
      exhausted += 1;
    } else {
      stillQueued += 1;
    }

    rows.push({
      invoiceId: invoice.id,
      etimsInvoiceNumber: invoice.etimsInvoiceNumber,
      saleNumber: invoice.sale.saleNumber,
      previousStatus: invoice.status,
      status: persisted.invoice.status,
      retryCount: persisted.invoice.retryCount,
      resultMsg: persisted.invoice.resultMsg,
    });
  }

  return { attempted: queued.length, signed, rejected, stillQueued, exhausted, rows };
}

/**
 * Resubmit ONE invoice on an operator's explicit instruction — the "I fixed the
 * cause, try again" button behind a REJECTED row, and the manual push behind a
 * QUEUED one. Keeps the number, like everything else here.
 */
export async function retryInvoice(
  db: TenantPrismaClient,
  invoiceId: string,
): Promise<EtimsInvoiceRow> {
  const invoice = await db.etimsInvoice.findUnique({
    where: { id: invoiceId },
    include: INVOICE_INCLUDE,
  });
  if (invoice === null) {
    throw new EtimsValidationError(`Unknown eTIMS invoice ${invoiceId}.`);
  }
  if (invoice.status === "SIGNED") {
    throw new EtimsStateError(
      `eTIMS invoice ${invoice.etimsInvoiceNumber.toString()} is already SIGNED and is a permanent fiscal record. Reverse it with a credit note if it was wrong; it cannot be resubmitted.`,
    );
  }

  const sale = await loadSaleForSigning(db, invoice.saleId, { allowVoided: true });
  const resolved = await resolveProvider(db, { requireEnabled: true });

  let originalNumber: number | null = null;
  if (invoice.invoiceType === "CREDIT_NOTE" && invoice.originalInvoiceId !== null) {
    const original = await db.etimsInvoice.findUnique({
      where: { id: invoice.originalInvoiceId },
      select: { etimsInvoiceNumber: true },
    });
    originalNumber = original?.etimsInvoiceNumber ?? null;
  }

  const request = buildSignRequest(
    invoice.etimsInvoiceNumber,
    invoice.invoiceType,
    originalNumber,
    sale,
    invoice.invoiceType === "CREDIT_NOTE" ? (invoice.resultMsg ?? "Credit note") : null,
  );
  const result = await resolved.provider.signInvoice(request, resolved.credentials);

  const persisted = await persistOutcome(db, invoice.id, invoice.saleId, result, invoice.retryCount + 1, {
    touchSaleFiscalStatus: invoice.invoiceType === "SALE",
  });
  return persisted.invoice;
}

// ---------------------------------------------------------------------------
// 5. Reads — the failed-invoice dashboard
// ---------------------------------------------------------------------------

export interface ListInvoiceFilters {
  status?: EtimsInvoiceStatus;
  saleId?: string;
  invoiceType?: EtimsInvoiceType;
}

export async function listInvoices(
  db: TenantPrismaClient,
  filters: ListInvoiceFilters = {},
): Promise<EtimsInvoiceRow[]> {
  const invoices = await db.etimsInvoice.findMany({
    where: {
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.saleId !== undefined ? { saleId: filters.saleId } : {}),
      ...(filters.invoiceType !== undefined ? { invoiceType: filters.invoiceType } : {}),
    },
    include: INVOICE_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  return invoices.map(toInvoiceRow);
}

export async function getInvoice(
  db: TenantPrismaClient,
  id: string,
): Promise<EtimsInvoiceRow | null> {
  const invoice = await db.etimsInvoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
  return invoice === null ? null : toInvoiceRow(invoice);
}

/** The signed invoice for a sale, for the receipt. Null for the usual unsigned sale. */
export async function getSignedInvoiceForSale(
  db: TenantPrismaClient,
  saleId: string,
): Promise<EtimsInvoiceRow | null> {
  const invoice = await db.etimsInvoice.findFirst({
    where: { saleId, invoiceType: "SALE" },
    include: INVOICE_INCLUDE,
  });
  return invoice === null ? null : toInvoiceRow(invoice);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function resolveProvider(
  db: TenantPrismaClient,
  options: { requireEnabled?: boolean } = {},
): Promise<ResolvedEtimsProvider> {
  try {
    return await getEtimsProviderForTenant(db, options);
  } catch (error) {
    if (error instanceof NoActiveCredentialError) {
      // Option A, stated plainly to the operator: there is no shared signer to
      // fall back to, and that is deliberate.
      throw new EtimsNotConfiguredError(
        "This tenant has no active eTIMS credentials. eTIMS invoices are signed under the TENANT's own KRA PIN and OSCU device — there is no shared signer to fall back to. Store the credentials under /v1/integrations/ETIMS and initialize the device. Sales continue to finalize normally without eTIMS.",
      );
    }
    throw error;
  }
}

async function requireInitializedDevice(
  db: TenantPrismaClient,
  resolved: ResolvedEtimsProvider,
): Promise<EtimsDeviceRow> {
  const { credentials } = resolved;
  const device = await db.etimsDevice.findUnique({
    where: {
      tin_bhfId_dvcSrlNo: {
        tin: credentials.tin,
        bhfId: credentials.bhfId,
        dvcSrlNo: credentials.dvcSrlNo,
      },
    },
  });
  if (device === null || !device.initialized) {
    throw new EtimsNotConfiguredError(
      `The eTIMS device for TIN ${credentials.tin} (branch ${credentials.bhfId}) has not been initialized with KRA. Run POST /v1/etims/device/initialize first — initialization obtains the communication key every invoice must carry.`,
    );
  }
  if (!resolved.initialized) {
    throw new EtimsNotConfiguredError(
      `The eTIMS device is marked initialized but the stored credential holds no communication key. Re-run POST /v1/etims/device/initialize.`,
    );
  }
  return device;
}

interface SaleForSigning {
  id: string;
  saleNumber: string;
  status: string;
  subtotal: Cents;
  vatTotal: Cents;
  total: Cents;
  businessTimestamp: Date | null;
  createdAt: Date;
  customerPin: string | null;
  customerName: string | null;
  lines: EtimsInvoiceLine[];
}

async function loadSaleForSigning(
  db: TenantPrismaClient,
  saleId: string,
  options: { allowVoided?: boolean } = {},
): Promise<SaleForSigning> {
  const sale = await db.sale.findUnique({
    where: { id: saleId },
    include: {
      lines: {
        include: { product: { select: { sku: true, name: true } } },
        orderBy: { lineNumber: "asc" },
      },
      customer: { select: { name: true, kraPin: true } },
    },
  });
  if (sale === null) {
    throw new EtimsValidationError(`Unknown sale ${saleId}.`);
  }
  if (sale.status === "VOIDED" && options.allowVoided !== true) {
    throw new EtimsValidationError(
      `Sale ${sale.saleNumber} is VOIDED and cannot be fiscally signed. A voided sale did not happen; filing it with KRA would declare revenue the business did not earn.`,
    );
  }

  return {
    id: sale.id,
    saleNumber: sale.saleNumber,
    status: sale.status,
    subtotal: sale.subtotal,
    vatTotal: sale.vatTotal,
    total: sale.total,
    businessTimestamp: sale.businessTimestamp,
    createdAt: sale.createdAt,
    customerPin: sale.customer?.kraPin ?? null,
    customerName: sale.customer?.name ?? null,
    lines: sale.lines.map((line) => ({
      lineNumber: line.lineNumber,
      itemCode: line.product.sku,
      description: line.product.name,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice,
      discount: line.discount,
      vatRate: line.vatRate.toString(),
      taxCode: effectiveLineTax(line).taxCode,
      lineNet: line.lineNet,
      lineVat: line.lineVat,
      lineTotal: line.lineTotal,
    })),
  };
}

/**
 * Build the normalized request. eTIMS NEVER RECOMPUTES MONEY: every figure is the
 * one the sale already posted, so the invoice KRA receives and the revenue the
 * ledger holds are the same numbers by construction rather than by agreement.
 *
 * The sale is dated to its BUSINESS time where it has one (an offline-synced sale
 * happened when the till rang it, not when the server received it), falling back
 * to createdAt for an ordinary online sale — which IS its business time.
 */
function buildSignRequest(
  invoiceNumber: number,
  invoiceType: EtimsInvoiceType,
  originalInvoiceNumber: number | null,
  sale: SaleForSigning,
  reason: string | null,
): EtimsSignRequest {
  return {
    invoiceNumber,
    invoiceType,
    ...(originalInvoiceNumber !== null ? { originalInvoiceNumber } : {}),
    saleNumber: sale.saleNumber,
    salesDate: sale.businessTimestamp ?? sale.createdAt,
    customerPin: sale.customerPin,
    customerName: sale.customerName,
    lines: sale.lines,
    subtotal: sale.subtotal,
    vatTotal: sale.vatTotal,
    total: sale.total,
    ...(reason !== null ? { reason } : {}),
  };
}

interface AllocateInvoiceInput {
  saleId: string;
  invoiceType: EtimsInvoiceType;
  originalInvoiceId: string | null;
  deviceId: string;
  createdBy: string;
}

/**
 * Allocate the next per-device invoice number and create the PENDING invoice row,
 * in ONE transaction, with the device row locked FOR UPDATE.
 *
 * The lock is what makes concurrent signing safe: two cashiers signing at the same
 * instant serialise on the device row and take 7 and 8, never 7 and 7. The unique
 * index on (device, number) is the structural backstop behind the lock.
 */
async function allocateInvoice(
  db: TenantPrismaClient,
  schema: string,
  input: AllocateInvoiceInput,
): Promise<RawInvoice> {
  return db.$transaction(async (tx) => {
    const number = await allocateInvoiceNumberWithinTransaction(tx, schema, input.deviceId);
    return tx.etimsInvoice.create({
      data: {
        saleId: input.saleId,
        invoiceType: input.invoiceType,
        originalInvoiceId: input.originalInvoiceId,
        etimsDeviceId: input.deviceId,
        etimsInvoiceNumber: number,
        status: "PENDING",
        createdBy: input.createdBy,
      },
      include: INVOICE_INCLUDE,
    });
  });
}

/**
 * The counter. `UPDATE ... SET lastInvoiceNo = lastInvoiceNo + 1 RETURNING` is
 * atomic on its own and takes the row lock implicitly, so two concurrent
 * allocations cannot read the same value.
 *
 * Schema-qualified, because the pg adapter does not set search_path (the engineering ledger,
 * "Raw SQL and Tenant Schema Resolution").
 */
async function allocateInvoiceNumberWithinTransaction(
  tx: LedgerTx,
  schema: string,
  deviceId: string,
): Promise<number> {
  assertValidSchemaName(schema);
  const rows = await tx.$queryRawUnsafe<Array<{ next_no: number }>>(
    `UPDATE "${schema}".etims_devices
        SET "lastInvoiceNo" = "lastInvoiceNo" + 1, "updatedAt" = now()
      WHERE "id" = $1
      RETURNING "lastInvoiceNo" AS next_no`,
    deviceId,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new EtimsValidationError(
      `eTIMS device ${deviceId} disappeared while allocating an invoice number.`,
    );
  }
  return Number(row.next_no);
}

interface PersistOptions {
  /** Whether this outcome should move Sale.fiscalStatus. False for credit notes. */
  touchSaleFiscalStatus?: boolean;
  /** Connectivity retries are exhausted: park as FAILED for an operator. */
  exhaustRetries?: boolean;
}

interface PersistedOutcome {
  invoice: EtimsInvoiceRow;
  fiscalStatus: SaleFiscalStatus;
}

/**
 * Map ONE provider outcome onto the database. The whole of the status policy lives
 * here, in one place, so the online path, the sync path and the retry sweep cannot
 * diverge on what a rejection means.
 *
 *   SIGNED               -> invoice SIGNED + artifacts;        sale SIGNED
 *   REJECTED             -> invoice REJECTED + code/message;   sale FAILED
 *                           (never auto-retried)
 *   CONNECTIVITY_FAILURE -> invoice QUEUED, SAME number kept;  sale PENDING_ETIMS
 *                           (or FAILED once retries are exhausted)
 *
 * The invoice and the sale's fiscalStatus move in ONE transaction: a signed
 * invoice whose sale still reads PENDING_ETIMS would show as unfiled on the
 * dashboard forever.
 *
 * SECRETS ARE STRIPPED BEFORE PERSISTENCE. The provider already keeps the cmcKey
 * out of the body it builds, and the raw response is scrubbed here as well,
 * because selectInitOsdcInfo-style responses echo the key and a stored response is
 * a stored credential if nobody checks.
 */
async function persistOutcome(
  db: TenantPrismaClient,
  invoiceId: string,
  saleId: string,
  result: EtimsSignResult,
  retryCount: number,
  options: PersistOptions = {},
): Promise<PersistedOutcome> {
  const touchSale = options.touchSaleFiscalStatus !== false;
  const now = new Date();
  const submittedPayload = scrubSecrets(result.submittedPayload);
  const rawResponse = scrubSecrets(result.rawResponse);

  let invoiceStatus: EtimsInvoiceStatus;
  let fiscalStatus: SaleFiscalStatus;
  if (result.outcome === "SIGNED") {
    invoiceStatus = "SIGNED";
    fiscalStatus = "SIGNED";
  } else if (result.outcome === "REJECTED") {
    invoiceStatus = "REJECTED";
    fiscalStatus = "FAILED";
  } else if (options.exhaustRetries === true) {
    invoiceStatus = "FAILED";
    fiscalStatus = "FAILED";
  } else {
    invoiceStatus = "QUEUED";
    fiscalStatus = "PENDING_ETIMS";
  }

  const updated = await db.$transaction(async (tx) => {
    const invoice = await tx.etimsInvoice.update({
      where: { id: invoiceId },
      data: {
        status: invoiceStatus,
        retryCount,
        lastAttemptAt: now,
        submittedPayload,
        rawResponse,
        ...(result.outcome === "SIGNED"
          ? {
              kraReceiptNumber: result.artifacts.kraReceiptNumber,
              rcptSign: result.artifacts.rcptSign,
              intrlData: result.artifacts.intrlData,
              sdcDateTime: result.artifacts.sdcDateTime,
              qrCodeUrl: result.artifacts.qrCodeUrl,
              resultCode: null,
              resultMsg: null,
            }
          : result.outcome === "REJECTED"
            ? { resultCode: result.resultCode, resultMsg: result.resultMsg }
            : { resultCode: null, resultMsg: result.resultMsg }),
      },
      include: INVOICE_INCLUDE,
    });

    if (touchSale) {
      // The ONLY field eTIMS ever changes on a sale. Migration 0016's guard
      // enforces the legal transitions even against a bug here, and refuses to
      // downgrade a SIGNED sale at all.
      await tx.sale.update({ where: { id: saleId }, data: { fiscalStatus } });
    }

    return invoice;
  });

  return { invoice: toInvoiceRow(updated), fiscalStatus };
}

/**
 * Remove any value that looks like a stored secret from an audit string.
 *
 * Belt and braces: the payload builder already keeps the cmcKey in the HTTP
 * headers rather than the body, so nothing should match. This runs anyway because
 * "should" is not a guarantee, and a credential that reaches an audit column is a
 * credential in every database backup from then on.
 */
function scrubSecrets(text: string): string {
  if (text === "") {
    return text;
  }
  // Replace the VALUE of any JSON key whose name is a known secret field,
  // regardless of nesting, without needing to parse a possibly-invalid body.
  return text.replace(
    /"(cmcKey|authToken|consumerSecret|passkey|initiatorPassword)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
    '"$1":"[REDACTED]"',
  );
}
