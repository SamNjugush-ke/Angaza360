// ===========================================================================
// SYNC INGEST — replaying captured offline sales (Task OFF.1).
//
// THIS MODULE ORCHESTRATES; IT NEVER RE-IMPLEMENTS. It writes `captured_sales`
// (its own ingest ledger) and asks other services for everything else:
//
//   * the SALE is posted by src/services/sales.ts through
//     recordSaleWithinTransaction — the SAME atomic sale transaction an online
//     sale uses, under the SAME database triggers;
//   * the STOCK decrement and the COGS posting happen inside that, through
//     src/services/inventory.ts, as they always do;
//   * every GL effect goes through src/services/ledger.ts, as it always does;
//   * `pos_devices` is written by src/services/offline/custody.ts;
//   * `stock_freezes` and frozenQuantity are handled by
//     src/services/offline/freeze.ts (which itself delegates the stock work).
//
// This module writes no journal table, no stock table, no sale table. An offline
// sale becomes a journal entry ONLY on the server, and only through the one
// posting path that already existed.
//
// ---------------------------------------------------------------------------
// WHY SERVER-SIDE STOCK RE-VALIDATION CANNOT FAIL — THE TASK 3.2-LOC LINKAGE
//
// This is the property that makes offline conflict-free, and it is INHERITED
// rather than invented here.
//
// A captured sale is replayed with the DEVICE'S LOCATION as its
// `sellingLocationId`. Task 3.2-LOC made the sale path location-aware: a sale
// draws from, and is checked against, the SELLING LOCATION's owned quantity, not
// the tenant-wide aggregate. And a device only ever sold stock its location
// ALREADY OWNED — the allocation (Task 10.2) transferred that stock into the
// location BEFORE the device went offline, and nothing else can sell it, because
// every location owns its stock exclusively (Task 10.1).
//
// So the stock the replay needs was reserved to that location before the sale was
// ever made. There is no shared pool to race for, so there is no race to lose and
// nothing to reconcile: the re-validation on sync passes BECAUSE the location owns
// the stock, not because we checked optimistically and got lucky.
//
// The re-validation still RUNS, with FOR UPDATE row locks, because a guarantee
// you stop checking is a guarantee you stop having. When it does fail it means
// something genuinely unusual happened — the allocation was frozen by an expired
// lease, or a bug moved stock that should not have moved — and the capture goes to
// the NEEDS_RESOLUTION queue rather than being dropped or forced negative.
//
// ---------------------------------------------------------------------------
// ONE ASSUMPTION THIS MODULE MAKES OF THE DEVICE, stated because it is load-
// bearing for the freeze release: A SYNC DELIVERS THE DEVICE'S COMPLETE OUTBOX.
//
// "The device synced" is what releases a freeze — the truth has arrived, so the
// genuinely unsold remainder can go back to MAIN. That inference is only sound if
// the batch IS everything the device was holding. A device that flushed half its
// outbox would be telling the server it sold less than it did, and the remainder
// returned to MAIN would include goods that had already left the shelf.
//
// The server cannot verify this — only the device knows what is in its own queue —
// so it is the DEVICE/PWA task's contract: flush the whole outbox, or flush
// nothing. An EMPTY batch is therefore meaningful and is honoured: it says "I sold
// nothing", and the whole allocation returns to MAIN. What the server does
// guarantee is the half that is checkable: nothing is lost if the assumption is
// broken (every capture that arrives later still posts, idempotently, at its true
// business date) and nothing goes negative (the location's owned quantity is
// re-checked under a row lock on every single capture).
// ---------------------------------------------------------------------------
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import type { CapturedSaleStatus, SaleFiscalStatus } from "../../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../../db/tenant";
import { businessDateOf } from "../../lib/business-time";
import {
  InsufficientStockError,
  InventoryValidationError,
  withInventoryErrorTranslation,
} from "../inventory";
import { LedgerValidationError, PeriodClosedError, type LedgerTx } from "../ledger";
import {
  recordSaleWithinTransaction,
  SaleValidationError,
  type SaleLineInput,
  type SaleTenderInput,
} from "../sales";
import {
  EtimsNotConfiguredError,
  EtimsStateError,
  EtimsValidationError,
  signSaleInvoice,
} from "../etims/etims-signing";
import { markSyncedWithinTransaction, type DeviceRow } from "./custody";
import {
  getActiveFreezeForLocation,
  refreezeAfterIncompleteSync,
  releaseFreezeAfterSync,
  thawForSync,
  type FreezeRow,
} from "./freeze";

/** Bad input (unknown device, malformed batch). Route -> 400. */
export class SyncValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncValidationError";
  }
}

/**
 * How far into the future a device's clock may be wrong before its capture is
 * treated as unpostable rather than accepted. A future-dated sale would post into
 * a period that has not happened yet, so it is queued for the owner instead.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

// ---------------------------------------------------------------------------
// The wire shape of a captured sale
// ---------------------------------------------------------------------------

/**
 * A sale CAPTURED on a device. Deliberately the same line/tender structure as an
 * online sale, because it IS one — it is replayed through the same function.
 *
 * NOTE WHAT IS ABSENT: there is no sellingLocationId. The selling location is
 * derived from the DEVICE on the server and is never accepted from the request. A
 * device may only ever sell from the location it was registered against, so
 * letting a capture name its own location would be handing a client the ability to
 * draw stock out of any location it liked. Same principle as deriving the tenant
 * from the session rather than the body.
 */
export interface CapturedSaleInput {
  /** The device's unique key for this sale. Replaying it is a no-op. */
  idempotencyKey: string;
  /** When the sale ACTUALLY happened at the till. The journal entry dates to this. */
  businessTimestamp: Date;
  /** The shift it was rung on. Must still be OPEN — see the note on outcomes below. */
  shiftId: string;
  customerId?: string;
  reference?: string;
  lines: SaleLineInput[];
  tenders: SaleTenderInput[];
  /**
   * THE PER-SALE eTIMS OPT-IN, captured OFFLINE (Task 4.1).
   *
   * A device cannot sign: eTIMS needs KRA, and KRA is online-only. So the device
   * records only that the customer ASKED for a KRA invoice, and the SERVER signs
   * on sync — which is exactly the "deferred online operation" the offline design
   * anticipated. There is no second signing path: the sync ingest calls the same
   * signSaleInvoice the online POS route does.
   *
   * Offline at capture therefore means nothing special here. If KRA is reachable
   * when the batch arrives, the invoice signs; if not, it QUEUES with its allocated
   * number, which is the ordinary connectivity case.
   */
  requestEtims?: boolean;
}

export interface IngestSyncBatchInput {
  deviceId: string;
  sales: CapturedSaleInput[];
  /** The authenticated actor delivering the batch. NOT who rang the sales. */
  syncedBy: string;
}

export interface SyncSaleOutcome {
  idempotencyKey: string;
  outcome: CapturedSaleStatus;
  saleId: string | null;
  saleNumber: string | null;
  /** When the sale actually happened — preserved exactly as captured. */
  businessTimestamp: Date;
  /** The date the journal entry was DATED to. Null when nothing posted. */
  entryDate: Date | null;
  /**
   * true when the closed-period fallback was taken: the capture's own period was
   * already closed, so the entry posted into the current open period instead.
   */
  postedToCurrentPeriod: boolean;
  /** The true business date, recorded on the sale when the fallback was taken. */
  originalBusinessDate: Date | null;
  /** Why it could not post. Null unless the outcome is NEEDS_RESOLUTION. */
  reason: string | null;
  /**
   * The eTIMS result for a capture that requested one (Task 4.1). Null when no KRA
   * invoice was asked for — the common case — or when nothing posted.
   *
   * A signing failure NEVER affects the sale's outcome above: the sale is already
   * committed and final either way.
   */
  etims: CaptureEtimsOutcome | null;
}

/** What signing did to a synced sale that asked for a KRA invoice. */
export interface CaptureEtimsOutcome {
  /**
   * The sale's resulting fiscal status, or NOT_ATTEMPTED when eTIMS could not even
   * be tried (the tenant has not configured it). NOT_REQUESTED is in the union only
   * because it is a legal SaleFiscalStatus; signSaleInvoice never returns it.
   */
  fiscalStatus: SaleFiscalStatus | "NOT_ATTEMPTED";
  invoiceId: string | null;
  etimsInvoiceNumber: number | null;
  /** Why it was not signed, when it was not. */
  note: string | null;
}

export interface FreezeResolutionReport {
  freezeId: string;
  outcome: "RELEASED_BY_SYNC" | "KEPT_FROZEN";
  /** What went back to MAIN as genuinely unsold. Empty when kept frozen. */
  returnedToMain: Array<{ productId: string; sku: string; quantity: string }>;
  /** Why the freeze was kept, when it was. */
  note: string | null;
}

export interface IngestSyncBatchResult {
  deviceId: string;
  deviceName: string;
  locationId: string;
  locationCode: string;
  syncedAt: Date;
  results: SyncSaleOutcome[];
  summary: { posted: number; replayed: number; needsResolution: number };
  /** Present only when this sync met an active lease freeze. */
  freezeResolution: FreezeResolutionReport | null;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Ingest a batch of captured sales from one device.
 *
 * ORDER: oldest businessTimestamp first, always. Periods must fill in the order
 * things actually happened — entry numbers and entry dates then read in business
 * order rather than in whatever order a device's outbox happened to flush.
 *
 * ONE TRANSACTION PER SALE, not one per batch. A batch is a transport convenience,
 * not a unit of work: one capture that cannot post must not roll back twenty that
 * can. Each transaction covers the whole of ONE sale — its stock decrement, its
 * COGS entries, its revenue entry, the sale row and the captured_sales row that
 * records its arrival — so a sale and the evidence of its arrival are never out of
 * step.
 *
 * A device of ANY status may sync. Only an ACTIVE device may take custody and
 * sell (see custody.startLease), but a SUSPENDED or RETIRED device must still be
 * able to hand in what it already captured: refusing would strand real sales that
 * really happened, which is the one outcome worse than a late posting.
 */
export async function ingestSyncBatch(
  db: TenantPrismaClient,
  input: IngestSyncBatchInput,
): Promise<IngestSyncBatchResult> {
  const schema = resolveSchema(db);

  const device = await db.posDevice.findUnique({
    where: { id: input.deviceId },
    include: { location: { select: { code: true, isActive: true } } },
  });
  if (device === null) {
    throw new SyncValidationError(`Unknown device ${input.deviceId}.`);
  }
  if (!device.location.isActive) {
    throw new SyncValidationError(
      `Device ${device.deviceName} serves location ${device.location.code}, which has been deactivated. Reactivate it before syncing: a sale must post to the location it was rung at.`,
    );
  }

  const duplicateKey = findDuplicateKey(input.sales);
  if (duplicateKey !== null) {
    throw new SyncValidationError(
      `Batch contains the same idempotencyKey twice ("${duplicateKey}"). Each captured sale carries its own key.`,
    );
  }

  const syncedAt = new Date();

  // If this device's location is frozen, make its stock available again BEFORE
  // the replay. The sales being replayed came out of exactly that stock, and an
  // outbound movement is checked against SELLABLE — so without this the truth
  // could not be recorded. The freeze row stays PENDING_RECONCILIATION until the
  // batch's outcome is known.
  const thawed = await thawForSync(db, device.locationId);

  const ordered = [...input.sales].sort(
    (a, b) => a.businessTimestamp.getTime() - b.businessTimestamp.getTime(),
  );

  const results: SyncSaleOutcome[] = [];
  for (const capture of ordered) {
    const outcome = await ingestOne(
      db,
      schema,
      device.id,
      device.locationId,
      capture,
      input.syncedBy,
      syncedAt,
    );

    // eTIMS SIGNS AFTER THE SALE HAS COMMITTED, never inside its transaction.
    // ingestOne's transaction has returned by here, so the sale is final: a KRA
    // outage or rejection can change the fiscal record and nothing else. This is
    // the same post-commit discipline the online POS route uses, through the same
    // signSaleInvoice — one signing path, two callers.
    if (outcome.outcome === "POSTED" && capture.requestEtims === true && outcome.saleId !== null) {
      outcome.etims = await signCapturedSale(db, outcome.saleId, input.syncedBy);
    }

    results.push(outcome);
  }

  // The device has checked in. Recorded AFTER the replay, so the period-close
  // guard can never see "this device has synced" before the sales it synced
  // actually exist.
  await db.$transaction((tx) => markSyncedWithinTransaction(tx, device.id, syncedAt));

  const summary = {
    posted: results.filter((row) => row.outcome === "POSTED").length,
    replayed: results.filter((row) => row.outcome === "REPLAYED").length,
    needsResolution: results.filter((row) => row.outcome === "NEEDS_RESOLUTION").length,
  };

  let freezeResolution: FreezeResolutionReport | null = null;
  if (thawed !== null) {
    freezeResolution = await resolveFreeze(db, thawed.freezeId, summary.needsResolution);
  }

  return {
    deviceId: device.id,
    deviceName: device.deviceName,
    locationId: device.locationId,
    locationCode: device.location.code,
    syncedAt,
    results,
    summary,
    freezeResolution,
  };
}

/**
 * Sign a synced sale that asked for a KRA invoice.
 *
 * A SIGNING FAILURE IS NEVER A SYNC FAILURE. The sale posted; it is committed,
 * final and correct in the ledger and in stock. All that can vary here is the
 * fiscal record, so every expected eTIMS error is CAUGHT and REPORTED rather than
 * thrown — propagating one would abort a batch over a tax attestation and strand
 * the sales behind it.
 *
 * Only genuinely unexpected errors propagate, because those are bugs and should
 * surface loudly rather than be recorded as a fiscal note.
 */
async function signCapturedSale(
  db: TenantPrismaClient,
  saleId: string,
  syncedBy: string,
): Promise<CaptureEtimsOutcome> {
  try {
    const signed = await signSaleInvoice(db, saleId, syncedBy);
    return {
      fiscalStatus: signed.fiscalStatus,
      invoiceId: signed.invoice.id,
      etimsInvoiceNumber: signed.invoice.etimsInvoiceNumber,
      note:
        signed.fiscalStatus === "SIGNED"
          ? null
          : (signed.invoice.resultMsg ??
            "eTIMS did not sign this invoice; see the eTIMS invoice record."),
    };
  } catch (error) {
    if (
      error instanceof EtimsNotConfiguredError ||
      error instanceof EtimsValidationError ||
      error instanceof EtimsStateError
    ) {
      return {
        fiscalStatus: "NOT_ATTEMPTED",
        invoiceId: null,
        etimsInvoiceNumber: null,
        note: error.message,
      };
    }
    throw error;
  }
}

function findDuplicateKey(sales: ReadonlyArray<CapturedSaleInput>): string | null {
  const seen = new Set<string>();
  for (const sale of sales) {
    if (seen.has(sale.idempotencyKey)) {
      return sale.idempotencyKey;
    }
    seen.add(sale.idempotencyKey);
  }
  return null;
}

/**
 * Close out a freeze once the batch's outcome is known.
 *
 * ALL CAPTURES ACCOUNTED FOR -> release: the genuinely unsold remainder goes back
 * to MAIN (a value-neutral transfer) and the freeze is RELEASED_BY_SYNC.
 *
 * ANY CAPTURE IN THE QUEUE -> keep frozen. Those captures are sales that really
 * happened and have NOT posted, so part of the stock still sitting at the location
 * is already spoken for. Returning it to MAIN would be the auto-return the engineering ledger
 * forbids, made worse by the fact that we would be doing it while holding written
 * evidence that the goods were sold. The server refuses to guess; the owner's
 * queue clears first.
 */
async function resolveFreeze(
  db: TenantPrismaClient,
  freezeId: string,
  needsResolution: number,
): Promise<FreezeResolutionReport> {
  if (needsResolution > 0) {
    const refrozen = await refreezeAfterIncompleteSync(db, freezeId);
    return {
      freezeId,
      outcome: "KEPT_FROZEN",
      returnedToMain: [],
      note: `${needsResolution.toString()} captured sale(s) could not post, so part of this allocation is already spoken for. ${refrozen.length.toString()} product slice(s) remain frozen until the queue clears — the server will not return stock to MAIN that evidence says was sold.`,
    };
  }

  const released = await releaseFreezeAfterSync(db, freezeId);
  return {
    freezeId,
    outcome: "RELEASED_BY_SYNC",
    returnedToMain: released.returned,
    note: null,
  };
}

interface PostingDate {
  entryDate: Date;
  originalBusinessDate: Date | null;
}

/**
 * Decide WHICH DATE the journal entry carries.
 *
 * NORMAL: the capture's own business date. A sale done two days ago posts two days
 * ago, into that period. That is business-time integrity, and it is the default.
 *
 * CLOSED-PERIOD FALLBACK: if the capture's period has already CLOSED (the device
 * stayed dark past the period-close guard, or the owner closed over a flagged
 * freeze), the entry posts into the CURRENT open period instead, and the true
 * business date is recorded on the sale as originalBusinessDate. The record is
 * never lost and the real date stays auditable — which is the only honest option,
 * since the alternatives are dropping a real sale or reopening a signed period
 * behind the owner's back.
 *
 * Read inside the caller's transaction so the decision cannot be made against a
 * period someone is closing at the same moment.
 */
async function resolvePostingDate(
  tx: LedgerTx,
  businessTimestamp: Date,
  now: Date,
): Promise<PostingDate> {
  const businessDate = businessDateOf(businessTimestamp);
  const period = await tx.accountingPeriod.findUnique({
    where: {
      year_month: {
        year: businessDate.getUTCFullYear(),
        month: businessDate.getUTCMonth() + 1,
      },
    },
    select: { status: true },
  });

  // An absent period is created OPEN by the ledger when the entry posts, so an
  // old date with no period row is an ordinary business-time posting.
  if (period === null || period.status === "OPEN") {
    return { entryDate: businessTimestamp, originalBusinessDate: null };
  }

  const today = businessDateOf(now);
  const currentPeriod = await tx.accountingPeriod.findUnique({
    where: { year_month: { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 } },
    select: { status: true },
  });
  if (currentPeriod !== null && currentPeriod.status === "CLOSED") {
    // Both the business period and the current one are closed. There is nowhere
    // honest to post, so the capture is queued rather than forced anywhere.
    throw new SaleValidationError(
      `The capture's accounting period ${businessDate.toISOString().slice(0, 7)} is CLOSED and so is the current period ${today.toISOString().slice(0, 7)}. Reopen the current period before syncing; the sale is queued and nothing has been posted.`,
    );
  }

  return { entryDate: now, originalBusinessDate: businessDate };
}

/**
 * Classify a failure. A capture that trips a business rule is QUEUED for the
 * owner; anything else is a real fault and is rethrown so it surfaces as a 500
 * rather than being silently recorded as a business problem.
 */
function queueableReason(error: unknown): string | null {
  if (
    error instanceof SaleValidationError ||
    error instanceof InsufficientStockError ||
    error instanceof InventoryValidationError ||
    error instanceof LedgerValidationError ||
    error instanceof PeriodClosedError
  ) {
    return error.message;
  }
  return null;
}

/** A unique-constraint violation on either idempotency key — a concurrent replay. */
function isIdempotencyCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /sales_idempotencyKey_key|captured_sales_idempotencyKey_key/.test(message);
}

async function ingestOne(
  db: TenantPrismaClient,
  schema: string,
  deviceId: string,
  locationId: string,
  capture: CapturedSaleInput,
  syncedBy: string,
  syncedAt: Date,
): Promise<SyncSaleOutcome> {
  const payload = JSON.stringify({
    idempotencyKey: capture.idempotencyKey,
    businessTimestamp: capture.businessTimestamp.toISOString(),
    shiftId: capture.shiftId,
    customerId: capture.customerId ?? null,
    reference: capture.reference ?? null,
    requestEtims: capture.requestEtims === true,
    lines: capture.lines,
    tenders: capture.tenders,
  });

  try {
    return await withInventoryErrorTranslation(() =>
      db.$transaction(async (tx) => {
        // 1. IDEMPOTENCY. A key that has already POSTED is a no-op: no second
        // journal entry, no second stock decrement, no error. At-least-once
        // delivery is therefore safe and a device may retry freely.
        const replayed = await findPostedReplay(tx, capture.idempotencyKey);
        if (replayed !== null) {
          return replayed;
        }

        // 2. Device clock sanity. A capture dated in the future would post into a
        // period that has not happened; queue it instead of accepting it.
        if (capture.businessTimestamp.getTime() > syncedAt.getTime() + CLOCK_SKEW_TOLERANCE_MS) {
          throw new SaleValidationError(
            `businessTimestamp ${capture.businessTimestamp.toISOString()} is in the future (server time ${syncedAt.toISOString()}). The device's clock is wrong; the sale is queued and nothing has been posted.`,
          );
        }

        // 3. WHICH PERIOD. Business time by default; the fallback when it is shut.
        const posting = await resolvePostingDate(tx, capture.businessTimestamp, syncedAt);

        // 4. POST IT — through the EXISTING atomic sale transaction, with the
        // DEVICE'S LOCATION as the selling location. The stock re-validation and
        // the location-ownership check inside this call are Task 3.2-LOC's, not a
        // reimplementation, and they pass because the location owns the stock.
        const sale = await recordSaleWithinTransaction(tx, schema, {
          shiftId: capture.shiftId,
          ...(capture.customerId !== undefined ? { customerId: capture.customerId } : {}),
          ...(capture.reference !== undefined ? { reference: capture.reference } : {}),
          lines: capture.lines,
          tenders: capture.tenders,
          // Records the REQUEST inside the sale transaction (fiscalStatus
          // PENDING_ETIMS). The submission itself happens after this transaction
          // commits — see signCapturedSale.
          ...(capture.requestEtims === true ? { requestEtims: true } : {}),
          // Overridden inside the sale service by the shift's cashier: an offline
          // sale is attributed to whoever rang it, not to whoever synced it.
          createdBy: syncedBy,
          entryDate: posting.entryDate,
          sellingLocationId: locationId,
          offline: {
            businessTimestamp: capture.businessTimestamp,
            syncedAt,
            deviceId,
            idempotencyKey: capture.idempotencyKey,
            ...(posting.originalBusinessDate !== null
              ? { originalBusinessDate: posting.originalBusinessDate }
              : {}),
          },
          ...(posting.originalBusinessDate !== null
            ? {
                entryNote: `offline sale of ${posting.originalBusinessDate
                  .toISOString()
                  .slice(0, 10)}, posted into the current open period because that period is closed`,
              }
            : {}),
        });

        // 5. Record the arrival, in THIS transaction. The sale and the evidence
        // of its arrival land together or not at all.
        await upsertCaptured(tx, {
          idempotencyKey: capture.idempotencyKey,
          deviceId,
          businessTimestamp: capture.businessTimestamp,
          payload,
          status: "POSTED",
          reason: null,
          saleId: sale.id,
          syncedBy,
          resolvedAt: syncedAt,
        });

        const outcome: SyncSaleOutcome = {
          idempotencyKey: capture.idempotencyKey,
          outcome: "POSTED",
          saleId: sale.id,
          saleNumber: sale.saleNumber,
          businessTimestamp: capture.businessTimestamp,
          entryDate: businessDateOf(posting.entryDate),
          postedToCurrentPeriod: posting.originalBusinessDate !== null,
          originalBusinessDate: posting.originalBusinessDate,
          reason: null,
          // Filled in by the caller AFTER this transaction commits, if asked for.
          etims: null,
        };
        return outcome;
      }),
    );
  } catch (error) {
    // A concurrent delivery of the same batch won the race. The sale exists
    // exactly once, which is the guarantee the unique index gives us; report this
    // call honestly as a replay.
    if (isIdempotencyCollision(error)) {
      const replayed = await db.$transaction((tx) => findPostedReplay(tx, capture.idempotencyKey));
      if (replayed !== null) {
        return replayed;
      }
    }

    const reason = queueableReason(error);
    if (reason === null) {
      throw error;
    }

    // NOTHING WAS POSTED: the transaction above rolled back in full — no journal
    // entry, no stock movement, no sale, nothing negative anywhere. The capture is
    // recorded in the owner's queue with the exact payload that was attempted, so
    // it is visible and retryable rather than lost. A separate transaction,
    // necessarily, because the first one no longer exists.
    await db.$transaction((tx) =>
      upsertCaptured(tx, {
        idempotencyKey: capture.idempotencyKey,
        deviceId,
        businessTimestamp: capture.businessTimestamp,
        payload,
        status: "NEEDS_RESOLUTION",
        reason,
        saleId: null,
        syncedBy,
        resolvedAt: null,
      }),
    );

    return {
      idempotencyKey: capture.idempotencyKey,
      outcome: "NEEDS_RESOLUTION",
      saleId: null,
      saleNumber: null,
      businessTimestamp: capture.businessTimestamp,
      entryDate: null,
      postedToCurrentPeriod: false,
      originalBusinessDate: null,
      reason,
      // Nothing posted, so there is nothing to file with KRA.
      etims: null,
    };
  }
}

/**
 * Has this key already produced a sale? Checks BOTH ledgers:
 *
 *   * `captured_sales` — the ingest record, written in the same transaction as
 *     the sale;
 *   * `sales.idempotencyKey` — the structural guarantee. Its unique index is what
 *     actually makes a second posting impossible, so it is also what we trust when
 *     answering "has this already posted?".
 *
 * A NEEDS_RESOLUTION row is deliberately NOT a replay. Nothing was posted for it —
 * no journal entry, no stock movement, no sale — so re-attempting it is safe and is
 * the right behaviour: it is how the queue clears itself once the blocking
 * condition (a freeze, a closed shift, a shut period) is gone.
 */
async function findPostedReplay(
  tx: LedgerTx,
  idempotencyKey: string,
): Promise<SyncSaleOutcome | null> {
  const captured = await tx.capturedSale.findUnique({
    where: { idempotencyKey },
    include: { sale: { select: { saleNumber: true, businessTimestamp: true, originalBusinessDate: true } } },
  });
  if (captured !== null && captured.status === "POSTED" && captured.sale !== null) {
    return {
      idempotencyKey,
      outcome: "REPLAYED",
      saleId: captured.saleId,
      saleNumber: captured.sale.saleNumber,
      businessTimestamp: captured.businessTimestamp,
      entryDate: null,
      postedToCurrentPeriod: captured.sale.originalBusinessDate !== null,
      originalBusinessDate: captured.sale.originalBusinessDate,
      reason: null,
      // A replay signs nothing: signSaleInvoice is itself idempotent, and the
      // first delivery already resolved this sale's fiscal state.
      etims: null,
    };
  }

  const sale = await tx.sale.findFirst({
    where: { idempotencyKey },
    select: {
      id: true,
      saleNumber: true,
      businessTimestamp: true,
      originalBusinessDate: true,
    },
  });
  if (sale !== null && sale.businessTimestamp !== null) {
    return {
      idempotencyKey,
      outcome: "REPLAYED",
      saleId: sale.id,
      saleNumber: sale.saleNumber,
      businessTimestamp: sale.businessTimestamp,
      entryDate: null,
      postedToCurrentPeriod: sale.originalBusinessDate !== null,
      originalBusinessDate: sale.originalBusinessDate,
      reason: null,
      etims: null,
    };
  }

  return null;
}

interface CapturedUpsert {
  idempotencyKey: string;
  deviceId: string;
  businessTimestamp: Date;
  payload: string;
  status: CapturedSaleStatus;
  reason: string | null;
  saleId: string | null;
  syncedBy: string;
  resolvedAt: Date | null;
}

/**
 * Write (or re-write) this capture's ingest record. An upsert because a capture
 * that previously landed in the queue may now post: the key is the same event, so
 * it keeps the same row and that row's status moves NEEDS_RESOLUTION -> POSTED.
 * `receivedAt` is not touched on an update — it records when the capture FIRST
 * arrived, which is the audit-relevant instant.
 */
async function upsertCaptured(tx: LedgerTx, row: CapturedUpsert): Promise<void> {
  await tx.capturedSale.upsert({
    where: { idempotencyKey: row.idempotencyKey },
    create: {
      idempotencyKey: row.idempotencyKey,
      deviceId: row.deviceId,
      businessTimestamp: row.businessTimestamp,
      payload: row.payload,
      status: row.status,
      reason: row.reason,
      saleId: row.saleId,
      syncedBy: row.syncedBy,
      resolvedAt: row.resolvedAt,
    },
    update: {
      status: row.status,
      reason: row.reason,
      saleId: row.saleId,
      payload: row.payload,
      syncedBy: row.syncedBy,
      resolvedAt: row.resolvedAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Reads — the device/owner transparency surface
// ---------------------------------------------------------------------------

export interface DeviceSyncStatus {
  device: DeviceRow;
  /** The live freeze over this device's location, if any. */
  freeze: FreezeRow | null;
  /** Captures from this device sitting in the owner's queue. */
  needsResolutionCount: number;
  /** Sales from this device that have posted. */
  postedCount: number;
}

export interface SyncStatusResult {
  devices: DeviceSyncStatus[];
  needsResolutionTotal: number;
}

export async function getSyncStatus(
  db: TenantPrismaClient,
  devices: ReadonlyArray<DeviceRow>,
): Promise<SyncStatusResult> {
  const rows: DeviceSyncStatus[] = [];
  let needsResolutionTotal = 0;

  for (const device of devices) {
    const [freeze, needsResolutionCount, postedCount] = await Promise.all([
      getActiveFreezeForLocation(db, device.locationId),
      db.capturedSale.count({ where: { deviceId: device.id, status: "NEEDS_RESOLUTION" } }),
      db.capturedSale.count({ where: { deviceId: device.id, status: "POSTED" } }),
    ]);
    needsResolutionTotal += needsResolutionCount;
    rows.push({ device, freeze, needsResolutionCount, postedCount });
  }

  return { devices: rows, needsResolutionTotal };
}

export interface NeedsResolutionRow {
  id: string;
  idempotencyKey: string;
  deviceId: string;
  deviceName: string;
  locationCode: string;
  businessTimestamp: Date;
  reason: string;
  /** The exact captured payload that was attempted, so the owner can see what it was. */
  payload: string;
  syncedBy: string;
  receivedAt: Date;
}

/**
 * The owner's queue: captures that could not post. Nothing in here has had any
 * financial effect — no journal entry, no stock movement, no sale — so nothing in
 * here can be making a balance wrong. They are sales that HAPPENED and have not
 * yet been recorded, which is a different and visible problem.
 */
export async function listNeedsResolution(
  db: TenantPrismaClient,
  filters: { deviceId?: string } = {},
): Promise<NeedsResolutionRow[]> {
  const rows = await db.capturedSale.findMany({
    where: {
      status: "NEEDS_RESOLUTION",
      ...(filters.deviceId !== undefined ? { deviceId: filters.deviceId } : {}),
    },
    include: {
      device: { include: { location: { select: { code: true } } } },
    },
    orderBy: { businessTimestamp: "asc" },
  });

  return rows.map((row) => ({
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    deviceId: row.deviceId,
    deviceName: row.device.deviceName,
    locationCode: row.device.location.code,
    businessTimestamp: row.businessTimestamp,
    // NEEDS_RESOLUTION always carries a reason (CHECK in migration 0015); the
    // fallback keeps the type honest without pretending the column is nullable
    // in this projection.
    reason: row.reason ?? "unknown",
    payload: row.payload,
    syncedBy: row.syncedBy,
    receivedAt: row.receivedAt,
  }));
}
