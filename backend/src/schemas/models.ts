// ===========================================================================
// Response models (Task G.3). One Zod schema per entity the API returns,
// enumerating EXACTLY the fields the handler sends.
//
// Why enumerate rather than passthrough: a response schema that lists its
// fields is the contract clients build against, and — for the credential
// routes — it is the mechanism that makes leaking a secret structurally
// impossible rather than a matter of remembering. The cost is that a field
// added to a Prisma model does not appear in the API until it is added here,
// which is the correct default for a financial API.
//
// Money is zCentsString (a string of KES cents). Quantities and rates are
// zDecimalString. Neither is ever a JSON number.
// ===========================================================================

import { z } from "zod";
import {
  AccountClass,
  AllocationRequestStatus,
  CapturedSaleStatus,
  CredentialStatus,
  CustomerReceiptMethod,
  DeviceStatus,
  EmployeePaymentMethod,
  EmployeeStatus,
  EmploymentType,
  EtimsInvoiceStatus,
  EtimsInvoiceType,
  FreezeStatus,
  IntegrationEnvironment,
  IntegrationProvider,
  JournalEntryStatus,
  JournalSource,
  KraTaxCode,
  LocationType,
  MpesaTxnStatus,
  NormalBalance,
  PaymentStatus,
  PayrollRunStatus,
  PayrollSettlementMethod,
  PeriodStatus,
  PurchaseOrderStatus,
  SaleFiscalStatus,
  SaleOrigin,
  SalePaymentStatus,
  SaleStatus,
  ShiftStatus,
  StatutoryType,
  StockMovementType,
  SupplierBillStatus,
  SupplierPaymentMethod,
  TaxClass,
  TenantTaxRegime,
  TenderType,
} from "../generated/tenant/enums";
import {
  ActionItemStatus,
  ActionParty,
  GoalStatus,
  IndicatorSourceKey,
  MentorshipEngagementStatus,
  UserRole,
} from "../generated/platform/enums";
import {
  zCentsString,
  zCentsStringNullable,
  zDecimalString,
  zDecimalStringNullable,
  zTimestamp,
  zTimestampNullable,
} from "./common";

// Enum schemas built FROM the Prisma-generated enums, so a datamodel change
// that adds a value cannot leave the docs behind.
export const zAccountClass = z.enum(AccountClass);
export const zNormalBalance = z.enum(NormalBalance);
export const zJournalSource = z.enum(JournalSource);
export const zJournalEntryStatus = z.enum(JournalEntryStatus);
export const zPeriodStatus = z.enum(PeriodStatus);
export const zStockMovementType = z.enum(StockMovementType);
export const zTenderType = z.enum(TenderType);
export const zPaymentStatus = z.enum(PaymentStatus);
export const zSaleStatus = z.enum(SaleStatus);
export const zSalePaymentStatus = z.enum(SalePaymentStatus);
export const zShiftStatus = z.enum(ShiftStatus);
export const zMpesaTxnStatus = z.enum(MpesaTxnStatus);
export const zUserRole = z.enum(UserRole);
export const zIntegrationProvider = z.enum(IntegrationProvider);
export const zIntegrationEnvironment = z.enum(IntegrationEnvironment);
export const zCredentialStatus = z.enum(CredentialStatus);
export const zLocationType = z.enum(LocationType);
export const zAllocationRequestStatus = z.enum(AllocationRequestStatus);
export const zDeviceStatus = z.enum(DeviceStatus);
export const zSaleOrigin = z.enum(SaleOrigin);
export const zCapturedSaleStatus = z.enum(CapturedSaleStatus);
export const zFreezeStatus = z.enum(FreezeStatus);
export const zSaleFiscalStatus = z.enum(SaleFiscalStatus);
export const zEtimsInvoiceStatus = z.enum(EtimsInvoiceStatus);
export const zEtimsInvoiceType = z.enum(EtimsInvoiceType);
export const zPurchaseOrderStatus = z.enum(PurchaseOrderStatus);
export const zTenantTaxRegime = z.enum(TenantTaxRegime);
export const zSupplierBillStatus = z.enum(SupplierBillStatus);
export const zSupplierPaymentMethod = z.enum(SupplierPaymentMethod);
export const zCustomerReceiptMethod = z.enum(CustomerReceiptMethod);
export const zEmploymentType = z.enum(EmploymentType);
export const zEmployeeStatus = z.enum(EmployeeStatus);
export const zEmployeePaymentMethod = z.enum(EmployeePaymentMethod);
export const zPayrollRunStatus = z.enum(PayrollRunStatus);
export const zPayrollSettlementMethod = z.enum(PayrollSettlementMethod);
export const zTaxClass = z.enum(TaxClass).meta({
  description:
    "A product's VAT status under the VAT Act 2013 (Task 3B.1). STANDARD_RATED charges the standard rate; ZERO_RATED is vatable at 0% (the seller may still recover input VAT); EXEMPT is outside VAT. Output VAT is charged ONLY by a VAT-registered tenant, and only on STANDARD_RATED lines.",
});
export const zKraTaxCode = z.enum(KraTaxCode).meta({
  description:
    "KRA eTIMS tax-type code (TIS for OSCU/VSCU v2.0): B standard rate, C zero-rated 0%, A exempt, D non-VAT (every line of a seller not registered for VAT). The SAME code is printed on the receipt, used in the VAT return and sent to KRA.",
});
export const zStatutoryType = z.enum(StatutoryType);

// ---- Products -------------------------------------------------------------

/** Task T-A8: a GOOD is stock; a SERVICE carries none and posts no cost of sale. */
export const zProductType = z.enum(["GOOD", "SERVICE"]).meta({
  description: "GOOD is stock (received, held, valued, depleted). SERVICE carries no stock: its sale posts revenue and VAT/TOT only — no stock movement and no cost of sales. Fixed once created.",
});

export const zProduct = z
  .object({
    id: z.string(),
    sku: z.string(),
    barcode: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    category: z.string().nullable(),
    unitOfMeasure: z.string(),
    imageUrl: z.string().nullable(),
    costPrice: zCentsString,
    price: zCentsString.meta({ description: "VAT-EXCLUSIVE shelf price in cents; VAT, when charged, is added on top." }),
    taxClass: zTaxClass,
    kind: zProductType,
    stockCount: zDecimalString,
    minStockThreshold: zDecimalString,
    reorderQuantity: zDecimalStringNullable,
    avgCost: zCentsString.meta({
      description:
        "DERIVED cache of stockValue / stockCount, rounded to cents. Never an input to stockValue.",
    }),
    stockValue: zCentsString.meta({
      description:
        "AUTHORITATIVE carrying value in cents. Moves only by exact posted deltas; never recomputed as stockCount * avgCost.",
    }),
    batchTracked: z.boolean(),
    expiryDate: zTimestampNullable,
    isActive: z.boolean(),
    supplierId: z.string().nullable(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "Product" });

// ---- Chart of accounts ----------------------------------------------------

export const zAccount = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    accountClass: zAccountClass,
    normalBalance: zNormalBalance,
    description: z.string().nullable(),
    isSystem: z.boolean(),
    isActive: z.boolean(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "Account" });

// ---- Ledger ---------------------------------------------------------------

export const zJournalLineResult = z.object({
  id: z.string(),
  lineNumber: z.number().int(),
  accountId: z.string(),
  accountCode: z.string(),
  accountName: z.string(),
  debit: zCentsString,
  credit: zCentsString,
  memo: z.string().nullable(),
});

export const zJournalEntryResult = z
  .object({
    id: z.string(),
    entryNumber: z.string(),
    entryDate: zTimestamp,
    periodYear: z.number().int(),
    periodMonth: z.number().int(),
    description: z.string(),
    reference: z.string().nullable(),
    source: zJournalSource,
    sourceId: z.string().nullable(),
    status: zJournalEntryStatus,
    reversesEntryId: z.string().nullable(),
    reversedByEntryId: z.string().nullable(),
    createdBy: z.string(),
    postedAt: zTimestamp,
    lines: z.array(zJournalLineResult),
  })
  .meta({ id: "JournalEntry" });

// The list/detail reads return the Prisma row with its nested lines, whose
// shape differs from the service's JournalEntryResult (line.account is nested).
const zJournalLineRow = z.object({
  id: z.string(),
  entryId: z.string(),
  lineNumber: z.number().int(),
  accountId: z.string(),
  debit: zCentsString,
  credit: zCentsString,
  memo: z.string().nullable(),
});

export const zJournalEntryListRow = z.object({
  id: z.string(),
  entryNumber: z.string(),
  entryDate: zTimestamp,
  periodYear: z.number().int(),
  periodMonth: z.number().int(),
  description: z.string(),
  reference: z.string().nullable(),
  source: zJournalSource,
  sourceId: z.string().nullable(),
  status: zJournalEntryStatus,
  reversesEntryId: z.string().nullable(),
  reversedByEntryId: z.string().nullable(),
  createdBy: z.string(),
  postedAt: zTimestamp,
  lines: z.array(
    zJournalLineRow.extend({
      account: z.object({ code: z.string(), name: z.string() }),
    }),
  ),
});

export const zJournalEntryDetail = z.object({
  id: z.string(),
  entryNumber: z.string(),
  entryDate: zTimestamp,
  periodYear: z.number().int(),
  periodMonth: z.number().int(),
  description: z.string(),
  reference: z.string().nullable(),
  source: zJournalSource,
  sourceId: z.string().nullable(),
  status: zJournalEntryStatus,
  reversesEntryId: z.string().nullable(),
  reversedByEntryId: z.string().nullable(),
  createdBy: z.string(),
  postedAt: zTimestamp,
  lines: z.array(
    zJournalLineRow.extend({
      account: z.object({
        code: z.string(),
        name: z.string(),
        accountClass: zAccountClass,
      }),
    }),
  ),
});

export const zTrialBalanceRow = z.object({
  code: z.string(),
  name: z.string(),
  accountClass: zAccountClass,
  normalBalance: zNormalBalance,
  totalDebit: zCentsString,
  totalCredit: zCentsString,
  balance: zCentsString,
});

export const zAccountLedgerRow = z.object({
  entryId: z.string(),
  entryNumber: z.string(),
  entryDate: zTimestamp,
  lineNumber: z.number().int(),
  description: z.string(),
  source: zJournalSource,
  status: zJournalEntryStatus,
  debit: zCentsString,
  credit: zCentsString,
  runningBalance: zCentsString,
});

export const zAccountingPeriod = z
  .object({
    id: z.string(),
    year: z.number().int(),
    month: z.number().int(),
    status: zPeriodStatus,
    closedAt: zTimestampNullable,
    closedBy: z.string().nullable(),
  })
  .meta({ id: "AccountingPeriod" });

// The /periods list read returns the raw Prisma row, which also carries
// createdAt.
export const zAccountingPeriodRow = zAccountingPeriod.extend({
  createdAt: zTimestamp,
});

// ---- Inventory ------------------------------------------------------------

export const zStockMovementResult = z
  .object({
    id: z.string(),
    productId: z.string(),
    movementType: zStockMovementType,
    quantity: zDecimalString,
    unitCost: zCentsString,
    totalCost: zCentsString,
    balanceQty: zDecimalString,
    balanceValue: zCentsString,
    avgCostAfter: zCentsString,
    avgCostAfterPrecise: zDecimalString.meta({
      description:
        "The derived unit rate after this movement, in cents to six decimal places. A rate, not money.",
    }),
    supplierId: z.string().nullable(),
    reference: z.string().nullable(),
    notes: z.string().nullable(),
    journalEntryId: z.string().nullable(),
    locationId: z.string().nullable(),
    goodsReceiptId: z.string().nullable().meta({
      description:
        "The goods receipt this movement was part of, when it came from a purchase order (Task 5.1). NULL on every other movement — an ad-hoc receipt, a sale, a transfer, an adjustment — which is the truthful statement that no PO was involved.",
    }),
    purchaseOrderLineId: z.string().nullable().meta({
      description:
        "The purchase-order line this movement fulfilled. Always paired with goodsReceiptId, or both are null.",
    }),
    createdBy: z.string(),
    createdAt: zTimestamp,
  })
  .meta({ id: "StockMovement" });

export const zStockLevelRow = z.object({
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  unitOfMeasure: z.string(),
  stockCount: zDecimalString,
  minStockThreshold: zDecimalString,
  reorderQuantity: zDecimalStringNullable,
  avgCost: zCentsString,
  avgCostPrecise: zDecimalString,
  stockValue: zCentsString,
  belowReorder: z.boolean(),
});

export const zMovementHistoryRow = z.object({
  id: z.string(),
  movementType: zStockMovementType,
  quantity: zDecimalString,
  unitCost: zCentsString,
  totalCost: zCentsString,
  balanceQty: zDecimalString,
  balanceValue: zCentsString,
  avgCostAfter: zCentsString,
  supplierId: z.string().nullable(),
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  journalEntryId: z.string().nullable(),
  locationId: z.string().nullable(),
  goodsReceiptId: z.string().nullable(),
  purchaseOrderLineId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: zTimestamp,
});

// ---- Locations & allocation (Module 10, Task 10.2) -------------------------

export const zLocation = z
  .object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    type: zLocationType.meta({
      description:
        "MAIN (the single authoritative pool), POS (a till), ECOMMERCE (a storefront channel), BRANCH and ATTENDANT (the same model, enabled by adding rows — no schema change).",
    }),
    isDefault: z.boolean().meta({
      description: "Marks the single MAIN pool. Always the same row as type = MAIN.",
    }),
    isActive: z.boolean(),
    isOfflineCapable: z.boolean().meta({
      description:
        "Whether this location may sell while disconnected. Never true for MAIN or ECOMMERCE.",
    }),
    leaseWindowMinutes: z.number().int().nullable().meta({
      description:
        "The admin-set lease window in minutes. NULL means FOREVER — this location's allocation never freezes. Set only on offline-capable locations. This is CONFIG: lease expiry and the freeze to PENDING_RECONCILIATION are enforced by the offline server task, not by anything reading this field today.",
    }),
    sessionStart: z.string().nullable().meta({
      description: 'Optional daily selling window start, 24-hour "HH:MM". Set together with sessionEnd.',
    }),
    sessionEnd: z.string().nullable(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "Location" });

export const zAllocationRequest = z
  .object({
    id: z.string(),
    productId: z.string(),
    sku: z.string(),
    productName: z.string(),
    locationId: z.string(),
    locationCode: z.string(),
    locationName: z.string(),
    requestedQty: zDecimalString,
    approvedQty: zDecimalStringNullable.meta({
      description:
        "What the admin actually granted; may differ from requestedQty. NULL unless APPROVED.",
    }),
    status: zAllocationRequestStatus,
    requestedBy: z.string(),
    decidedBy: z.string().nullable().meta({
      description:
        "Who took the request out of PENDING — the approver, the decliner, or (for a cancellation) the requester.",
    }),
    decidedAt: zTimestampNullable,
    transferId: z.string().nullable().meta({
      description:
        "The TRANSFER_IN stock movement that delivered the approved stock into the requesting location. Set only on APPROVED; a DECLINED or CANCELLED request moves nothing and carries none.",
    }),
    note: z.string().nullable(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "AllocationRequest" });

export const zLowStockAlert = z
  .object({
    productId: z.string(),
    sku: z.string(),
    productName: z.string(),
    locationId: z.string(),
    locationCode: z.string(),
    locationName: z.string(),
    locationType: zLocationType,
    quantity: zDecimalString.meta({ description: "What this location currently OWNS." }),
    threshold: zDecimalString.meta({
      description:
        "Product.minStockThreshold, the catalog's reorder point, applied per location slice. A threshold of zero raises no alert.",
    }),
    shortfall: zDecimalString,
    reorderQuantity: zDecimalStringNullable,
    suggestedTransferQty: zDecimalString.meta({
      description:
        "What to move to clear the alert: the catalog reorder quantity, but never less than the shortfall.",
    }),
    mainAvailable: zDecimalString.meta({
      description: "What the MAIN pool owns, so the admin can see whether a top-up is possible.",
    }),
  })
  .meta({ id: "LowStockAlert" });

export const zSupplier = z
  .object({
    id: z.string(),
    name: z.string(),
    contactName: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    kraPin: z.string().nullable(),
    paymentTerms: z.string().nullable(),
    leadTimeDays: z.number().int().nullable(),
    isActive: z.boolean(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "Supplier" });

// ---- POS ------------------------------------------------------------------

export const zShiftSummary = z
  .object({
    id: z.string(),
    cashierId: z.string(),
    status: zShiftStatus,
    openingFloat: zCentsString,
    closingFloat: zCentsStringNullable,
    expectedCash: zCentsStringNullable,
    variance: zCentsStringNullable,
    openedAt: zTimestamp,
    closedAt: zTimestampNullable,
    saleCount: z.number().int(),
    gross: zCentsString,
    tenderBreakdown: z.object({
      CASH: zCentsString,
      MPESA: zCentsString,
      BANK_TRANSFER: zCentsString,
      CREDIT: zCentsString,
    }),
  })
  .meta({ id: "ShiftSummary" });

export const zSaleLineResult = z.object({
  lineNumber: z.number().int(),
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  quantity: zDecimalString,
  unitPrice: zCentsString,
  discount: zCentsString,
  vatRate: zDecimalString.meta({ description: "The rate APPLIED to this line — \"0.00\" unless it was charged under code B." }),
  taxClass: zTaxClass,
  taxCode: zKraTaxCode,
  lineNet: zCentsString,
  lineVat: zCentsString,
  lineTotal: zCentsString,
  unitCogs: zCentsString,
  lineCogs: zCentsStringNullable.meta({
    description:
      "The exact cost this line posted to the ledger. NULL on sales recorded before Task 3.1-FIX.",
  }),
});

export const zSaleTenderResult = z.object({
  id: z.string(),
  tenderType: zTenderType,
  amount: zCentsString,
  status: zPaymentStatus,
  mpesaReference: z.string().nullable(),
  mpesaTransactionId: z.string().nullable(),
});

export const zSaleResult = z
  .object({
    id: z.string(),
    saleNumber: z.string(),
    shiftId: z.string(),
    customerId: z.string().nullable(),
    status: zSaleStatus,
    paymentStatus: zSalePaymentStatus,
    subtotal: zCentsString,
    vatTotal: zCentsString,
    total: zCentsString,
    cogsTotal: zCentsString,
    saleJournalEntryId: z.string().nullable(),
    totAccrued: zCentsString.meta({
      description: "Turnover Tax accrued on this sale (Task 3B.2) — posted Dr 6110 / Cr 2110 inside the sale's entry for a TURNOVER_TAX tenant; 0 otherwise. A tax on the business: NOT part of what the customer pays.",
    }),
    voidedByEntryId: z.string().nullable(),
    voidReason: z.string().nullable(),
    reference: z.string().nullable(),
    createdBy: z.string(),
    createdAt: zTimestamp,
    sellingLocationId: z.string().nullable().meta({
      description:
        "The location this sale drew its stock from, and the location a void returns it to. NULL on sales recorded before the sale path became location-aware — those drew from MAIN by definition.",
    }),
    origin: zSaleOrigin.meta({
      description:
        "ONLINE (rung at the server) or OFFLINE_SYNCED (captured on a device and replayed through the same atomic sale transaction).",
    }),
    businessTimestamp: zTimestampNullable.meta({
      description:
        "When the sale ACTUALLY happened. The journal entry is dated to this. NULL on an online sale, where createdAt already is that instant.",
    }),
    syncedAt: zTimestampNullable.meta({
      description: "When the capture arrived at the server. Never conflated with businessTimestamp.",
    }),
    deviceId: z.string().nullable(),
    idempotencyKey: z.string().nullable().meta({
      description:
        "The capturing device's key for this sale. Replaying it is a no-op. NULL on an online sale.",
    }),
    originalBusinessDate: zTimestampNullable.meta({
      description:
        "Non-null ONLY when the closed-period fallback was taken: the capture's own period had already closed, so the entry posted into the current open period and the true business date is recorded here.",
    }),
    fiscalStatus: zSaleFiscalStatus.meta({
      description:
        "KRA eTIMS state. NOT_REQUESTED is the DEFAULT and the common case — most MSME sales are informal, carry no buyer PIN, and are validly finalized with no fiscal invoice. PENDING_ETIMS means a KRA invoice was asked for and is not signed yet (queued on a connectivity failure); SIGNED means KRA signed it; FAILED means KRA rejected it, or retries were exhausted. Signing never alters the sale's money, stock or ledger entries.",
    }),
    lines: z.array(zSaleLineResult),
    tenders: z.array(zSaleTenderResult),
  })
  .meta({ id: "Sale" });

export const zReceipt = z
  .object({
    business: z.object({
      name: z.string(),
      subdomain: z.string(),
      kraPin: z.string().nullable(),
      // Receipt header and branding (Task T-A13), from the business profile and the
      // tenant's own registry row.
      legalName: z.string().nullable(),
      addressLine: z.string().nullable(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
      brandPrimaryColor: z.string().nullable(),
      logoUrl: z.string().nullable().meta({ description: "Present only when a logo is set AND showLogoOnReceipt is true." }),
    }),
    footer: z.string().nullable().meta({ description: "The business's receipt footer (Task T-A13)." }),
    saleNumber: z.string(),
    timestamp: zTimestamp,
    status: zSaleStatus,
    lines: z.array(
      z.object({
        description: z.string(),
        quantity: zDecimalString,
        unitPrice: zCentsString,
        discount: zCentsString,
        vatRate: zDecimalString,
        taxCode: zKraTaxCode,
        lineNet: zCentsString,
        lineVat: zCentsString,
        lineTotal: zCentsString,
      }),
    ),
    vatSummary: z.object({
      subtotal: zCentsString,
      vatTotal: zCentsString,
      total: zCentsString,
    }),
    taxCodeSummary: z
      .array(
        z.object({
          code: zKraTaxCode,
          label: z.string(),
          rate: zDecimalString.meta({ description: "The rate applied under this code: the standard rate for B, \"0.00\" otherwise." }),
          vatableAmount: zCentsString.meta({ description: "Σ lineNet of the lines charged under this code." }),
          vatAmount: zCentsString.meta({ description: "Σ lineVat of those lines. Zero for every code but B." }),
        }),
      )
      .meta({
        description:
          "The VAT breakdown by KRA tax code, as on a Kenyan fiscal receipt. A non-VAT-registered seller's receipt carries a single D line — \"No VAT — not VAT registered\". Σ vatAmount == vatSummary.vatTotal, asserted when the receipt is built.",
      }),
    tenders: z.array(
      z.object({
        tenderType: zTenderType,
        amount: zCentsString,
        status: zPaymentStatus,
      }),
    ),
    amountTendered: zCentsString,
    changeDue: zCentsString,
    customer: z
      .object({ name: z.string(), loyaltyPoints: z.number().int() })
      .nullable(),
    etims: z
      .object({
        fiscalStatus: zSaleFiscalStatus,
        invoiceNumber: z.string().nullable().meta({
          description: "The device's sequential eTIMS invoice number, as a string.",
        }),
        kraReceiptNumber: z.string().nullable(),
        rcptSign: z.string().nullable().meta({
          description: "KRA's receipt signature. Reproduced verbatim; never generated locally.",
        }),
        intrlData: z.string().nullable(),
        sdcDateTime: z.string().nullable(),
        qrCode: z.string().nullable().meta({
          description: "KRA's verification URL, for the QR a buyer scans to check the invoice.",
        }),
      })
      .meta({
        description:
          "The KRA fiscal block. Every artifact is null unless the sale was SIGNED — most sales are NOT_REQUESTED and were validly finalized without a fiscal invoice, and a receipt must never imply one was filed.",
      }),
  })
  .meta({ id: "Receipt" });

// ---- Customers ------------------------------------------------------------

export const zCustomer = z
  .object({
    id: z.string(),
    name: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    kraPin: z.string().nullable(),
    loyaltyPoints: z.number().int(),
    creditLimit: zCentsString,
    creditBalance: zCentsString,
    isActive: z.boolean(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "Customer" });

// ---- Integrations ---------------------------------------------------------
// NOTE: this is the SAFE view and nothing else. It carries no ciphertext, no
// iv, no authTag, and above all no decrypted credential field. Adding a secret
// here would be the single change that could leak one, which is exactly why the
// shape is written down in one place and grep-checked in acceptance.

export const zCredentialSafeView = z
  .object({
    id: z.string(),
    provider: zIntegrationProvider,
    environment: zIntegrationEnvironment,
    status: zCredentialStatus,
    label: z.string().nullable(),
    keyRef: z.string().meta({
      description:
        "Names WHICH key encrypted the blob (the Cloud KMS migration seam). Naming a key does not disclose it.",
    }),
    lastVerifiedAt: zTimestampNullable,
    createdBy: z.string(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({
    id: "IntegrationCredential",
    description:
      "Safe view of a stored integration credential. Secret fields are write-only: they are accepted on PUT and are never returned by any endpoint.",
  });

export const zIntegrationSettingView = z
  .object({
    provider: zIntegrationProvider,
    activeEnvironment: zIntegrationEnvironment,
    enabled: z.boolean(),
    configured: z.boolean(),
    updatedAt: zTimestampNullable,
  })
  .meta({ id: "IntegrationSetting" });

// ---- Offline devices, sync & frozen allocation (Task OFF.1) -----------------

export const zPosDevice = z
  .object({
    id: z.string(),
    deviceName: z.string(),
    locationId: z.string(),
    locationCode: z.string(),
    locationName: z.string(),
    locationType: zLocationType,
    locationLeaseWindowMinutes: z.number().int().nullable().meta({
      description:
        "The LOCATION's admin-set lease policy, in minutes. NULL means FOREVER — a lease taken against it never expires.",
    }),
    status: zDeviceStatus.meta({
      description:
        "Only an ACTIVE device may take custody and sell. A SUSPENDED or RETIRED device may still SYNC what it already captured — refusing would strand real sales.",
    }),
    leaseStartedAt: zTimestampNullable.meta({
      description: "When this device last TOOK CUSTODY of its location's allocation.",
    }),
    leaseExpiresAt: zTimestampNullable.meta({
      description:
        "leaseStartedAt + the location's window AT THE TIME CUSTODY WAS TAKEN. NULL means FOREVER and never expires. Editing the location's policy later does not move a live lease.",
    }),
    holdsCustody: z.boolean().meta({
      description: "true while a lease has been started and not ended. A device holding no custody cannot block a period close.",
    }),
    leaseExpired: z.boolean().meta({
      description:
        "true only when a NON-NULL expiry is in the past. A forever lease is never expired. An expired lease whose stock has been frozen reads false here, because the freeze ends the lease — the freeze row is where that state lives.",
    }),
    lastSyncAt: zTimestampNullable,
    registeredBy: z.string(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "PosDevice" });

export const zFrozenSlice = z.object({
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  frozenQuantity: zDecimalString.meta({
    description: "The immobilised quantity at this location — removed from its sellable allocation.",
  }),
  ownedQuantity: zDecimalString.meta({
    description:
      "Total still OWNED at this location. A freeze does not change it, which is why Product.stockCount = SUM(per-location quantity) and sum(stockValue) = GL(1200) both survive a freeze untouched.",
  }),
});

export const zStockFreeze = z
  .object({
    id: z.string(),
    deviceId: z.string(),
    deviceName: z.string(),
    locationId: z.string(),
    locationCode: z.string(),
    locationName: z.string(),
    status: zFreezeStatus.meta({
      description:
        "PENDING_RECONCILIATION (live — immobilised, awaiting the truth or a decision), RELEASED_BY_SYNC (the device synced; real sales posted and the remainder went back to MAIN), or WRITTEN_OFF (an admin posted the loss, Dr 5300 / Cr 1200).",
    }),
    leaseExpiredAt: zTimestamp.meta({ description: "The lease expiry that triggered this freeze." }),
    frozenAt: zTimestamp,
    productCount: z.number().int().meta({
      description: "How many product slices were immobilised when the freeze was taken.",
    }),
    resolvedAt: zTimestampNullable,
    resolvedBy: z.string().nullable().meta({
      description:
        "NULL on a sync release — nobody decided anything, the device simply reported what it sold. Always set on a write-off: an accounting loss names its decider.",
    }),
    resolutionNote: z.string().nullable(),
  })
  .meta({ id: "StockFreeze" });

export const zStockFreezeDetail = zStockFreeze.extend({
  frozen: z.array(zFrozenSlice).meta({
    description: "What is immobilised right now. Empty once the freeze has resolved.",
  }),
});

export const zSyncSaleOutcome = z.object({
  idempotencyKey: z.string(),
  outcome: zCapturedSaleStatus.meta({
    description:
      "POSTED (became a real Sale through the atomic sale transaction), REPLAYED (this key had already posted — a no-op, no second journal entry and no second stock decrement), or NEEDS_RESOLUTION (could not post; NOTHING was posted and the capture is queued for the owner).",
  }),
  saleId: z.string().nullable(),
  saleNumber: z.string().nullable(),
  businessTimestamp: zTimestamp.meta({
    description: "When the sale actually happened — preserved exactly as captured.",
  }),
  entryDate: zTimestampNullable.meta({
    description: "The date the journal entry was DATED to. Null when nothing posted.",
  }),
  postedToCurrentPeriod: z.boolean().meta({
    description:
      "true when the closed-period fallback was taken: this capture's own period had already closed, so the entry posted into the current open period instead of being dropped.",
  }),
  originalBusinessDate: zTimestampNullable.meta({
    description: "The true business date, recorded on the sale when the fallback was taken.",
  }),
  reason: z.string().nullable(),
  etims: z
    .object({
      fiscalStatus: z.string().meta({
        description:
          "The sale's resulting KRA fiscal status, or NOT_ATTEMPTED when eTIMS could not be tried (the tenant has not configured it).",
      }),
      invoiceId: z.string().nullable(),
      etimsInvoiceNumber: z.number().int().nullable(),
      note: z.string().nullable(),
    })
    .nullable()
    .meta({
      description:
        "Present only for a capture that requested a KRA invoice (Task 4.1). A device cannot sign — eTIMS needs KRA — so the SERVER signs on sync, as a deferred online operation through the same signSaleInvoice the online POS uses. A signing failure NEVER changes the sale's outcome above: the sale is already committed and final.",
    }),
});

export const zFreezeResolutionReport = z.object({
  freezeId: z.string(),
  outcome: z.enum(["RELEASED_BY_SYNC", "KEPT_FROZEN"]),
  returnedToMain: z.array(
    z.object({ productId: z.string(), sku: z.string(), quantity: zDecimalString }),
  ),
  note: z.string().nullable(),
});

export const zSyncBatchResult = z
  .object({
    deviceId: z.string(),
    deviceName: z.string(),
    locationId: z.string(),
    locationCode: z.string(),
    syncedAt: zTimestamp,
    results: z.array(zSyncSaleOutcome),
    summary: z.object({
      posted: z.number().int(),
      replayed: z.number().int(),
      needsResolution: z.number().int(),
    }),
    freezeResolution: zFreezeResolutionReport.nullable().meta({
      description: "Present only when this sync met an active lease freeze over the device's location.",
    }),
  })
  .meta({ id: "SyncBatchResult" });

export const zDeviceSyncStatus = z.object({
  device: zPosDevice,
  freeze: zStockFreeze.nullable(),
  needsResolutionCount: z.number().int(),
  postedCount: z.number().int(),
});

export const zNeedsResolutionRow = z
  .object({
    id: z.string(),
    idempotencyKey: z.string(),
    deviceId: z.string(),
    deviceName: z.string(),
    locationCode: z.string(),
    businessTimestamp: zTimestamp,
    reason: z.string(),
    payload: z.string().meta({
      description:
        "The exact captured payload that was attempted, as JSON, so the owner can see what the sale was. Money and quantities inside it are strings, as everywhere.",
    }),
    syncedBy: z.string(),
    receivedAt: zTimestamp,
  })
  .meta({ id: "CapturedSaleNeedingResolution" });

export const zWriteOffMovement = z.object({
  movementId: z.string(),
  productId: z.string(),
  quantity: zDecimalString,
  totalCost: zCentsString.meta({
    description: "The carrying value written off for this product — the amount posted Dr 5300 / Cr 1200.",
  }),
  journalEntryId: z.string().nullable(),
});

export const zWriteOffResult = z
  .object({
    freeze: zStockFreeze,
    movements: z.array(zWriteOffMovement),
    totalWrittenOff: zCentsString.meta({
      description: "Total posted to 5300 Inventory Write-offs by this write-off, in cents.",
    }),
  })
  .meta({ id: "FrozenStockWriteOff" });

// ---- KRA eTIMS fiscal signing (Module 9, Task 4.1) -------------------------
// NOTE WHAT IS ABSENT, deliberately and permanently: cmcKey and authToken. The
// communication key and the auth token are SECRETS held in the tenant's encrypted
// credential blob. They are accepted on a credential PUT (documented write-only)
// and are returned by NOTHING. The zod serialiser strips every property a response
// schema does not declare, so leaving them out here is what makes leaking one
// structurally impossible rather than a matter of remembering.

export const zEtimsDevice = z
  .object({
    id: z.string(),
    tin: z.string().meta({
      description:
        "The TENANT's own KRA PIN. Angaza is never the KRA integrator: every tenant self-onboards on eTIMS under their own PIN and files their own invoices. Not a secret — it appears on every fiscal receipt the business issues.",
    }),
    bhfId: z.string().meta({ description: 'Branch id, e.g. "00" for a single-branch business.' }),
    dvcSrlNo: z.string().meta({ description: "Device serial number registered with KRA." }),
    initialized: z.boolean().meta({
      description:
        "Whether KRA has issued this device a communication key. No invoice can be signed until it has.",
    }),
    lastInitAt: zTimestampNullable,
    lastInvoiceNo: z.number().int().meta({
      description:
        "The last invoice number issued by this device. Numbers are sequential per device and are allocated under a row lock, so two concurrent signs can never take the same one.",
    }),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "EtimsDevice" });

export const zEtimsInvoice = z
  .object({
    id: z.string(),
    saleId: z.string(),
    saleNumber: z.string(),
    invoiceType: zEtimsInvoiceType.meta({
      description:
        "SALE, or CREDIT_NOTE for the fiscal reversal of a signed sale that was voided.",
    }),
    originalInvoiceId: z.string().nullable().meta({
      description:
        "For a CREDIT_NOTE: the SIGNED invoice it reverses. KRA requires a credit note to reference the original and to come from the same solution that filed it.",
    }),
    etimsDeviceId: z.string(),
    etimsInvoiceNumber: z.number().int().meta({
      description:
        "The device's sequential number for this invoice. ALLOCATED BEFORE SUBMISSION AND REUSED ON EVERY RETRY — reallocating one would file the same sale with KRA twice.",
    }),
    status: zEtimsInvoiceStatus.meta({
      description:
        "PENDING (number allocated, not yet submitted); SIGNED (KRA signed it — terminal and immutable); REJECTED (KRA was reachable and refused the payload — never auto-retried, an operator fixes and resubmits); QUEUED (KRA was unreachable — retried later with the SAME number); FAILED (retries exhausted).",
    }),
    kraReceiptNumber: z.string().nullable(),
    rcptSign: z.string().nullable().meta({
      description: "KRA's receipt signature. Present only on SIGNED, and never generated locally.",
    }),
    intrlData: z.string().nullable(),
    sdcDateTime: z.string().nullable(),
    qrCodeUrl: z.string().nullable(),
    resultCode: z.string().nullable().meta({
      description: "KRA's own result code on a rejection. An opaque identifier, not a quantity.",
    }),
    resultMsg: z.string().nullable().meta({
      description: "Why KRA refused, or why the submission could not be delivered.",
    }),
    retryCount: z.number().int(),
    lastAttemptAt: zTimestampNullable,
    createdBy: z.string(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "EtimsInvoice" });

export const zEtimsSignResult = z
  .object({
    invoice: zEtimsInvoice,
    fiscalStatus: zSaleFiscalStatus,
    alreadySigned: z.boolean().meta({
      description:
        "true when the sale already had a SIGNED invoice and this call did nothing. A sale is filed with KRA once.",
    }),
    providerName: z.string().meta({
      description: 'Which implementation signed it: "simulated" in development, "oscu" against real KRA.',
    }),
  })
  .meta({ id: "EtimsSignResult" });

export const zEtimsInitResult = z
  .object({
    device: zEtimsDevice,
    keyStored: z.boolean().meta({
      description:
        "true when the communication key KRA returned was stored into the tenant's encrypted credential blob. The key itself is never returned.",
    }),
    environment: z.string(),
    providerName: z.string(),
  })
  .meta({ id: "EtimsDeviceInitResult" });

/** The eTIMS note attached to a POS sale or a synced capture. Never fails the sale. */
export const zEtimsSaleNote = z
  .object({
    requested: z.boolean(),
    attempted: z.boolean(),
    fiscalStatus: zSaleFiscalStatus,
    invoiceId: z.string().nullable(),
    etimsInvoiceNumber: z.number().int().nullable(),
    note: z.string().nullable().meta({
      description:
        "Why the invoice is not signed, when it is not — eTIMS not configured, KRA unreachable, or KRA's rejection message. Informational only: the sale itself succeeded regardless.",
    }),
  })
  .meta({ id: "EtimsSaleNote" });

// ---- Business profile & procurement (Module 4, Task 5.1) --------------------

export const zBusinessProfile = z
  .object({
    taxRegime: zTenantTaxRegime.meta({
      description:
        "VAT_REGISTERED (charges and recovers VAT; purchase receipts capitalise the NET cost and recover input VAT), TURNOVER_TAX (3% turnover-tax regime) or EXEMPT. For the latter two the VAT paid on a purchase is unrecoverable and is therefore part of what the goods cost, so receipts capitalise the VAT-INCLUSIVE figure.",
    }),
    isVatRegistered: z.boolean().meta({
      description:
        "DERIVED from taxRegime and guaranteed by a database CHECK never to contradict it. Read-only: set taxRegime instead.",
    }),
    kraPin: z.string().nullable().meta({
      description:
        "The business's own KRA PIN as printed on its invoices. Public business identity — distinct from the eTIMS integration credential, which is a secret in the encrypted store.",
    }),
    legalName: z.string().nullable().meta({ description: "Registered legal name, printed on receipts (Task T-A13)." }),
    addressLine: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    receiptFooter: z.string().nullable().meta({ description: "Printed at the foot of every receipt." }),
    showLogoOnReceipt: z.boolean(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "BusinessProfile" });

export const zPurchaseOrderLine = z.object({
  id: z.string(),
  productId: z.string(),
  sku: z.string(),
  productName: z.string(),
  orderedQty: zDecimalString,
  unitCost: zCentsString.meta({
    description:
      "Cost per unit in KES cents. NET (VAT-exclusive) for a VAT-registered tenant; VAT-INCLUSIVE for a non-registered one, because an unrecoverable tax is part of what the goods cost. In BOTH cases this is exactly the amount that reaches account 1200 on receipt.",
  }),
  lineNet: zCentsString.meta({
    description: "orderedQty x unitCost, rounded once through the single rounding primitive.",
  }),
  receivedQty: zDecimalString.meta({
    description: "How much has actually arrived. Moved only by a goods receipt, and capped at orderedQty by a database CHECK.",
  }),
  outstandingQty: zDecimalString.meta({ description: "orderedQty - receivedQty." }),
});

export const zPurchaseOrder = z
  .object({
    id: z.string(),
    poNumber: z.number().int().meta({
      description:
        "Sequential per tenant. Monotonic and unique, but NOT gap-free: a rolled-back order burns its number, which is a far smaller problem than two orders sharing one.",
    }),
    supplierId: z.string(),
    supplierName: z.string(),
    status: zPurchaseOrderStatus.meta({
      description:
        "DRAFT (freely editable, no financial effect at all) -> APPROVED (committed to the supplier; may now be received against) -> PARTIALLY_RECEIVED -> RECEIVED -> CLOSED. CANCELLED is reachable only from DRAFT or APPROVED: once goods have arrived the order DID happen and value has been accrued to GRNI, so such an order is CLOSED short instead.",
    }),
    orderDate: zTimestamp,
    expectedDate: zTimestampNullable,
    currency: z.string().meta({
      description: "Always \"KES\" today. The column is the multi-currency plug; a CHECK pins it until the FX work is done.",
    }),
    subtotal: zCentsString.meta({ description: "Sum of the lines' net amounts, in cents." }),
    notes: z.string().nullable(),
    createdById: z.string(),
    approvedById: z.string().nullable(),
    approvedAt: zTimestampNullable,
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
    lines: z.array(zPurchaseOrderLine),
  })
  .meta({ id: "PurchaseOrder" });

export const zGoodsReceiptLine = z.object({
  purchaseOrderLineId: z.string(),
  productId: z.string(),
  sku: z.string(),
  quantity: zDecimalString,
  totalCost: zCentsString.meta({
    description:
      "The cost this line accrued: the single figure that moved Product.stockValue, was debited to 1200 Inventory and was credited to 2050 GRNI. One valuation event per movement.",
  }),
  stockMovementId: z.string(),
  journalEntryId: z.string().nullable(),
});

export const zGoodsReceipt = z
  .object({
    id: z.string(),
    grnNumber: z.number().int(),
    poId: z.string(),
    poNumber: z.number().int(),
    receivingLocationId: z.string(),
    receivingLocationCode: z.string(),
    receivedById: z.string(),
    receivedAt: zTimestamp,
    notes: z.string().nullable(),
    createdAt: zTimestamp,
    lines: z.array(zGoodsReceiptLine),
    purchaseOrderStatus: zPurchaseOrderStatus,
    totalAccrued: zCentsString.meta({
      description: "Total credited to 2050 GRNI by this receipt — what is now owed to the supplier but not yet invoiced.",
    }),
  })
  .meta({
    id: "GoodsReceipt",
    description:
      "An IMMUTABLE posted fact: goods arrived, stock rose, and value was accrued to GRNI. The database refuses both UPDATE and DELETE on it. A mis-receipt is corrected with a supplier credit (Task 5.2), never by editing history.",
  });

// --- Accounts payable (Module 7, Task 5.2) ---------------------------------

export const zSupplierBillLine = z.object({
  id: z.string(),
  kind: z.enum(["PO_MATCH", "EXPENSE"]).meta({
    description:
      "PO_MATCH: goods ordered and received — the line CLEARS 2050 GRNI and does NOT touch inventory, because the goods were already valued when they arrived. EXPENSE: a cost with nothing received against it, debited straight to its own account.",
  }),
  description: z.string(),
  quantity: zDecimalString,
  vatRate: zDecimalString.meta({
    description:
      "The VAT percentage charged on this line, as a decimal STRING. A RATE, NOT MONEY. Always \"0.00\" for a non-VAT-registered tenant: there is no recoverable tax, and the VAT the supplier charged is already inside lineNet.",
  }),
  lineNet: zCentsString.meta({
    description:
      "quantity x unit cost, rounded once through the single rounding primitive. VAT-EXCLUSIVE for a VAT-registered tenant; the WHOLE invoiced amount for a non-registered one, because an unrecoverable tax is part of what the purchase cost — the same regime-dependent meaning PurchaseOrderLine.unitCost carries.",
  }),
  lineVat: zCentsString.meta({
    description: "Recoverable input VAT on this line. Always 0 for a non-registered tenant.",
  }),
  lineTotal: zCentsString.meta({ description: "lineNet + lineVat, CHECK-enforced." }),
  purchaseOrderLineId: z.string().nullable(),
  productId: z.string().nullable(),
  sku: z.string().nullable(),
  unitCostNet: zCentsStringNullable.meta({
    description:
      "The net unit cost the supplier INVOICED, which need not be the unitCost the order agreed and GRNI was accrued at. PO_MATCH lines only.",
  }),
  grniCleared: zCentsStringNullable.meta({
    description:
      "What this line took out of 2050 GRNI. NULL until the bill is posted, and NULL forever on an EXPENSE line. A line that fully bills its purchase order line clears the ENTIRE remaining accrual, so GRNI reaches exactly zero rather than nearly zero.",
  }),
  priceVariance: zCentsStringNullable.meta({
    description:
      "lineNet - grniCleared. Positive means the supplier invoiced MORE than the order agreed. It is posted to 5250 Purchase Price Variance rather than added to stock, because the goods may already have been sold — restating their cost would rewrite a reported margin.",
  }),
  expenseAccountCode: z.string().nullable(),
});

export const zSupplierBill = z
  .object({
    id: z.string(),
    billNumber: z.string().meta({
      description:
        "THE SUPPLIER'S OWN invoice reference, not a number we allocate. Unique per supplier, which is the DUPLICATE-PAYMENT GUARD: the same invoice arriving twice cannot become two payables.",
    }),
    supplierId: z.string(),
    supplierName: z.string(),
    poId: z.string().nullable(),
    poNumber: z.number().int().nullable(),
    billDate: zTimestamp,
    dueDate: zTimestamp.meta({
      description:
        "When it falls due, and what the aging report buckets on. Derived from the supplier's payment terms when none is given (\"Net 30\"), and otherwise equal to billDate — due on receipt, which ages immediately rather than hiding in \"current\".",
    }),
    status: zSupplierBillStatus.meta({
      description:
        "DRAFT (keyed in, NOTHING posted to the ledger, freely editable) -> AWAITING_PAYMENT (posted) -> PARTIALLY_PAID -> PAID. CANCELLED is reachable only while nothing has been paid; cancelling a POSTED bill reverses its journal entry and gives the billed quantity back. PAID and CANCELLED are terminal.",
    }),
    subtotalNet: zCentsString,
    vatTotal: zCentsString,
    total: zCentsString.meta({
      description:
        "The gross amount owed: subtotalNet + vatTotal, CHECK-enforced. This is the figure credited to 2000 Accounts Payable.",
    }),
    amountPaid: zCentsString.meta({
      description:
        "Allocated by supplier payments. CHECK-capped at total, so over-paying one invoice is unrepresentable, and a DEFERRED database constraint pins it to the sum of its allocations.",
    }),
    balance: zCentsString.meta({ description: "total - amountPaid: what is still owed." }),
    currency: z.string().meta({
      description: "Always \"KES\" today; the column is the multi-currency plug and a CHECK pins it.",
    }),
    notes: z.string().nullable(),
    createdById: z.string(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
    lines: z.array(zSupplierBillLine),
  })
  .meta({ id: "SupplierBill" });

export const zSupplierBillDetail = zSupplierBill
  .extend({
    journalEntryId: z.string().nullable().meta({
      description:
        "The entry that posted this bill, once posted. Derived from the entry's own sourceId rather than stored, so there is no second copy of the link to fall out of step.",
    }),
  })
  .meta({ id: "SupplierBillDetail" });

export const zSupplierPaymentAllocation = z.object({
  id: z.string(),
  billId: z.string(),
  billNumber: z.string(),
  amount: zCentsString,
});

export const zSupplierPayment = z
  .object({
    id: z.string(),
    paymentNumber: z.number().int().meta({
      description:
        "Sequential per tenant. Monotonic and unique, NOT gap-free: a rolled-back payment burns its number, which has no regulatory meaning, while two payments sharing one would be a reconciliation defect.",
    }),
    supplierId: z.string(),
    supplierName: z.string(),
    paymentDate: zTimestamp,
    method: zSupplierPaymentMethod.meta({
      description:
        "What selects the credit account: CASH -> 1000 Cash on Hand, BANK -> 1020 Bank Account, MPESA -> 1010 M-Pesa Till. **MPESA RECORDS, IT DOES NOT DISBURSE** — there is no B2B payout here; this is the record of money that went out through M-Pesa.",
    }),
    amount: zCentsString,
    reference: z.string().nullable(),
    notes: z.string().nullable(),
    createdById: z.string(),
    createdAt: zTimestamp,
    allocations: z.array(zSupplierPaymentAllocation).meta({
      description:
        "Which invoices this payment settled. Their amounts ALWAYS sum to the payment exactly — there is no on-account supplier balance, and a DEFERRED database constraint enforces it at COMMIT.",
    }),
  })
  .meta({
    id: "SupplierPayment",
    description:
      "An IMMUTABLE posted fact: money left the business. The database refuses both UPDATE and DELETE on it, and on its allocations.",
  });

const zAgingBuckets = z.object({
  current: zCentsString.meta({ description: "Not yet due." }),
  days1To30: zCentsString,
  days31To60: zCentsString,
  days61To90: zCentsString,
  over90: zCentsString,
});

export const zSupplierAgingRow = zAgingBuckets.extend({
  supplierId: z.string(),
  supplierName: z.string(),
  total: zCentsString,
  billCount: z.number().int(),
  oldestDueDate: zTimestampNullable,
});

export const zApAging = z
  .object({
    asOf: zTimestamp,
    suppliers: z.array(zSupplierAgingRow),
    totals: zAgingBuckets,
    grandTotal: zCentsString.meta({
      description:
        "The sum of every unpaid bill balance. **This is the AP that supplier bills have put into account 2000**, and the two reconciling is the acceptance criterion for the whole module.",
    }),
  })
  .meta({
    id: "ApAging",
    description:
      "Bucketed by DUE date over unpaid balances, per supplier. Only AWAITING_PAYMENT and PARTIALLY_PAID bills appear: a DRAFT posted nothing, a CANCELLED bill has been reversed, a PAID one is settled — including any of them would make the report disagree with account 2000.",
  });

export const zSupplierStatementEntry = z.object({
  kind: z.enum(["BILL", "PAYMENT"]),
  date: zTimestamp,
  reference: z.string(),
  description: z.string(),
  charged: zCentsString.meta({ description: "What the invoice added to what is owed. 0 on a payment." }),
  paid: zCentsString.meta({ description: "What the payment took off. 0 on a bill." }),
  runningBalance: zCentsString,
  billStatus: zSupplierBillStatus.nullable(),
  dueDate: zTimestampNullable,
});

export const zSupplierStatement = z
  .object({
    supplierId: z.string(),
    supplierName: z.string(),
    asOf: zTimestamp,
    entries: z.array(zSupplierStatementEntry),
    totalCharged: zCentsString,
    totalPaid: zCentsString,
    closingBalance: zCentsString.meta({
      description:
        "totalCharged - totalPaid, which equals this supplier's unpaid bill balances and therefore their slice of the aging report and of account 2000.",
    }),
  })
  .meta({
    id: "SupplierStatement",
    description:
      "Every POSTED invoice and every payment in date order with a running balance. DRAFT and CANCELLED bills are excluded: a cancelled bill's entry has been reversed, so showing its charge without the reversal would make the closing balance disagree with account 2000 — and a statement that does not reconcile is worth nothing.",
  });

// --- Accounts receivable (Module 6, Task 6) --------------------------------

export const zOpenCreditSale = z
  .object({
    saleId: z.string(),
    saleNumber: z.string(),
    customerId: z.string(),
    customerName: z.string(),
    saleDate: zTimestamp.meta({
      description:
        "The business date the receivable arose: the sale's `businessTimestamp` when it came from an offline device (that is when the customer actually took the goods), otherwise `createdAt`. Ageing an offline sale from its sync time would make a three-day-old debt look fresh.",
    }),
    saleTotal: zCentsString.meta({
      description: "The sale's full value, for context. **NOT the receivable** — a sale can be part cash, part credit.",
    }),
    creditTotal: zCentsString.meta({
      description:
        "The receivable this sale raised: the SUM of its CREDIT tenders. **DERIVED, never stored** — sale tenders are write-once, so the derivation cannot go stale, and there is no second column that could disagree with them.",
    }),
    arReceived: zCentsString.meta({
      description:
        "How much has been collected against it. The one mutable AR fact on a sale; a deferred database constraint pins it to the sum of the receipt allocations behind it and caps it at `creditTotal`.",
    }),
    outstanding: zCentsString.meta({ description: "creditTotal - arReceived: what is still owed." }),
    daysOutstanding: z.number().int(),
  })
  .meta({ id: "OpenCreditSale" });

export const zCustomerReceiptAllocation = z.object({
  id: z.string(),
  saleId: z.string(),
  saleNumber: z.string(),
  amount: zCentsString,
});

export const zCustomerReceipt = z
  .object({
    id: z.string(),
    receiptNumber: z.number().int().meta({
      description:
        "Sequential per tenant. Monotonic and unique, NOT gap-free: a rolled-back receipt burns its number, which has no regulatory meaning, while two receipts sharing one would be a reconciliation defect.",
    }),
    customerId: z.string(),
    customerName: z.string(),
    receiptDate: zTimestamp,
    method: zCustomerReceiptMethod.meta({
      description:
        "What selects the debit account: CASH -> 1000 Cash on Hand, BANK -> 1020 Bank Account, MPESA -> 1010 M-Pesa Till. **MPESA RECORDS, IT DOES NOT COLLECT** — there is no STK Pull here. The POS sale path's live STK Push (Task 3.3) is a different operation: that collects at the till for a sale being rung up, this records a customer paying down an account they already owe.",
    }),
    amount: zCentsString,
    reference: z.string().nullable(),
    notes: z.string().nullable(),
    createdById: z.string(),
    createdAt: zTimestamp,
    allocations: z.array(zCustomerReceiptAllocation).meta({
      description:
        "Which credit sales this receipt settled. Their amounts ALWAYS sum to the receipt exactly — there is no on-account customer balance, and DEFERRED database constraints bound to BOTH the receipt and its allocations enforce it at COMMIT, so a receipt with zero allocations is refused too.",
    }),
  })
  .meta({
    id: "CustomerReceipt",
    description:
      "An IMMUTABLE posted fact: money arrived. The database refuses both UPDATE and DELETE on it, and on its allocations. It posts `Dr cash|bank|M-Pesa / Cr 1100 Accounts Receivable` and touches NO revenue or VAT account — the sale recognised both at the till.",
  });

export const zCustomerReceiptDetail = zCustomerReceipt
  .extend({
    journalEntryId: z.string().nullable().meta({
      description:
        "The entry that posted this receipt. Derived from the entry's own sourceId rather than stored, so there is no second copy of the link to fall out of step.",
    }),
  })
  .meta({ id: "CustomerReceiptDetail" });

const zArAgingBuckets = z.object({
  current: zCentsString.meta({ description: "Raised today (age 0 days)." }),
  days1To30: zCentsString,
  days31To60: zCentsString,
  days61To90: zCentsString,
  over90: zCentsString,
});

export const zCustomerAgingRow = zArAgingBuckets.extend({
  customerId: z.string(),
  customerName: z.string(),
  total: zCentsString,
  saleCount: z.number().int(),
  oldestSaleDate: zTimestampNullable,
  creditBalance: zCentsString.meta({
    description:
      "The customer's own balance column. **It equals `total`**, and the two agreeing is the subledger invariant this module is accountable for — both are shown so an owner can see it hold.",
  }),
  creditLimit: zCentsString,
});

export const zArAging = z
  .object({
    asOf: zTimestamp,
    customers: z.array(zCustomerAgingRow),
    totals: zArAgingBuckets,
    grandTotal: zCentsString.meta({
      description:
        "The sum of every open credit sale's outstanding amount. **It equals SUM(Customer.creditBalance)**, and both equal GL(1100) MINUS the M-Pesa-failure residual — the AR that a failed STK Push posted to 1100 with no customer attribution (Task 3.3). See the engineering ledger \"Accounts Receivable\".",
    }),
  })
  .meta({
    id: "ArAging",
    description:
      "Bucketed by SALE date over per-sale outstanding amounts, grouped by customer. Aged by sale date rather than a due date because `Customer` carries no payment terms — inventing one would bake a guess into live data. Only COMPLETED credit sales appear: a VOIDED sale's receivable was reversed.",
  });

export const zCustomerStatementEntry = z.object({
  kind: z.enum(["CREDIT_SALE", "RECEIPT"]),
  date: zTimestamp,
  reference: z.string(),
  description: z.string(),
  charged: zCentsString.meta({
    description: "What the credit sale added to what is owed — the CREDIT portion only, never the sale total. 0 on a receipt.",
  }),
  received: zCentsString.meta({ description: "What the receipt took off. 0 on a sale." }),
  runningBalance: zCentsString,
});

export const zCustomerStatement = z
  .object({
    customerId: z.string(),
    customerName: z.string(),
    asOf: zTimestamp,
    entries: z.array(zCustomerStatementEntry),
    totalCharged: zCentsString,
    totalReceived: zCentsString,
    closingBalance: zCentsString.meta({
      description:
        "totalCharged - totalReceived. It equals `creditBalance` below and this customer's slice of the aging report; the three agreeing is the subledger invariant.",
    }),
    creditBalance: zCentsString.meta({ description: "The live column, so a reader can see the statement tie to it." }),
    creditLimit: zCentsString,
  })
  .meta({
    id: "CustomerStatement",
    description:
      "Every credit sale and every receipt in date order with a running balance. Only the CREDIT PORTION of each sale appears — a sale paid half in cash put only the credit half on the account. VOIDED sales are excluded: the void reversed both the receivable and the balance, so showing the charge without the reversal would break the tie-up, and a statement that does not reconcile is worth nothing.",
  });

// --- Payroll (Module 8, Task 8.1) ------------------------------------------

export const zPayeBand = z.object({
  ordinal: z.number().int(),
  lowerBound: zCentsString,
  upperBound: zCentsStringNullable.meta({ description: "NULL means the top band — unbounded above." }),
  ratePercent: zDecimalString.meta({ description: "A RATE as a decimal string, never money." }),
});

export const zStatutorySchedule = z
  .object({
    id: z.string(),
    label: z.string(),
    effectiveFrom: zTimestamp,
    effectiveTo: zTimestampNullable.meta({
      description: "NULL means OPEN-ENDED — the currently in-force ruleset. The window is half-open: [effectiveFrom, effectiveTo).",
    }),
    source: z.string().meta({
      description:
        "Where the figures came from. **Not decoration** — the engineering ledger requires the in-force statutory figures to be verified against an authoritative source at implementation time and the citation recorded, so the next person does not take them on trust. A database CHECK makes a blank citation impossible.",
    }),
    verifiedOn: zTimestamp.meta({ description: "The date the figures were last checked against the source." }),
    notes: z.string().nullable(),
    personalRelief: zCentsString.meta({
      description:
        "Monthly personal relief. A RELIEF AGAINST THE TAX, subtracted from the PAYE the bands produce — not a deduction from taxable pay. The engine keeps that distinction because conflating the two changes the answer.",
    }),
    nssfRatePercent: zDecimalString,
    nssfLowerLimit: zCentsString.meta({
      description: "The Tier I / Tier II BOUNDARY, not a floor on the contribution.",
    }),
    nssfUpperLimit: zCentsString.meta({ description: "Pensionable pay is capped here." }),
    shifRatePercent: zDecimalString,
    shifMinimum: zCentsString.meta({
      description: "The statutory MINIMUM monthly contribution. A low earner pays this rather than the percentage.",
    }),
    ahlRatePercent: zDecimalString,
    vatStandardRate: zDecimalString.meta({
      description:
        "The national STANDARD VAT rate for this window (Task 3B.1) — the only copy of that figure in the system. Zero-rated and exempt supplies are tax CLASSES, not rates.",
    }),
    vatRateSource: z.string().meta({ description: "Where the VAT rate came from (statute and authority)." }),
    vatRateVerifiedOn: zTimestamp.meta({ description: "When the VAT rate was last verified against that source." }),
    totRatePercent: zDecimalString.meta({
      description: "The Turnover Tax rate on gross turnover (Task 3B.2), accrued per sale by a TURNOVER_TAX tenant only. A RATE, never money.",
    }),
    totRateSource: z.string().meta({ description: "Where the TOT rate came from, including any recorded discrepancy between sources." }),
    totRateVerifiedOn: zTimestamp,
    createdById: z.string().nullable().meta({
      description: "Who created this version through the API (Task 3B.3). NULL = the system seed (provisioning / migration).",
    }),
    createdAt: zTimestamp,
    bands: z.array(zPayeBand).meta({
      description:
        "A CONTIGUOUS, ASCENDING partition of taxable pay from zero, with exactly one open-topped band at the end — enforced by a DEFERRED database constraint, because a gap would tax nothing in it and an overlap would tax the same shillings twice.",
    }),
  })
  .meta({
    id: "StatutorySchedule",
    description:
      "The effective-dated statutory ruleset — **the single source of every payroll rate in the system**. No statutory figure is a constant in code. EXACTLY ONE schedule may cover any date (a GiST exclusion constraint guarantees it), a payroll run records WHICH schedule computed it, and a rate change is a NEW dated row rather than an edit — so a run for a past period stays correct against the rates in force then. **These routes are READ-ONLY**: a statutory figure is the law of Kenya rather than tenant configuration, so it arrives by the same platform-run seed mechanism as the chart of accounts, never through an API.",
  });

export const zEmployeeAllowance = z.object({
  id: z.string(),
  name: z.string(),
  amount: zCentsString,
  taxable: z.boolean().meta({
    description:
      "A taxable allowance is part of the pay PAYE is computed on. BOTH kinds are part of gross — and therefore of NSSF, SHIF and the housing levy, which are computed on gross — which is why a payslip carries grossPay and taxableGross as two separate figures.",
  }),
});

export const zEmployee = z
  .object({
    id: z.string(),
    employeeNumber: z.number().int(),
    firstName: z.string(),
    lastName: z.string(),
    nationalId: z.string().nullable(),
    kraPin: z.string().nullable(),
    nssfNumber: z.string().nullable(),
    shifNumber: z.string().nullable(),
    employmentType: zEmploymentType.meta({
      description:
        "**Monthly salaried is the only shape this task computes.** The enum is the PLUG, so hourly, casual day-rate and contract-specific treatment arrive as new rows and a new engine branch rather than as an ALTER across live employee records.",
    }),
    status: zEmployeeStatus.meta({
      description:
        "ACTIVE employees are included in a NEW payroll run; SUSPENDED and TERMINATED are excluded. Neither deletes anything and neither touches a payslip already computed — those describe months the employee genuinely worked.",
    }),
    hireDate: zTimestamp,
    terminationDate: zTimestampNullable,
    basicSalary: zCentsString,
    paymentMethod: zEmployeePaymentMethod.meta({
      description: "SNAPSHOTTED onto the employee's net-pay settlement line (Task 8.2) for the bank payment file. It does not select the GL credit account — a run is paid from the ONE account its settlement names.",
    }),
    bankName: z.string().nullable(),
    bankAccount: z.string().nullable(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
    allowances: z.array(zEmployeeAllowance),
    grossMonthly: zCentsString.meta({ description: "basicSalary + every allowance. Derived." }),
  })
  .meta({ id: "Employee" });

export const zPayslipEarning = z.object({
  name: z.string(),
  amount: zCentsString,
  taxable: z.boolean(),
});

export const zPayslip = z
  .object({
    id: z.string(),
    payrollRunId: z.string(),
    employeeId: z.string(),
    employeeNumber: z.number().int(),
    employeeName: z.string(),
    grossPay: zCentsString.meta({ description: "basic + EVERY allowance. The base for NSSF, SHIF and the housing levy." }),
    taxableGross: zCentsString.meta({ description: "basic + only the TAXABLE allowances." }),
    nssfEmployee: zCentsString,
    nssfEmployer: zCentsString.meta({ description: "MATCHED to the employee's, not computed a second time, so the two can never disagree by a rounding." }),
    nssfTier1: zCentsString.meta({
      description: "The reportable tier split. Computed as a residual so tier1 + tier2 equals the employee contribution EXACTLY (a database CHECK pins it).",
    }),
    nssfTier2: zCentsString,
    shifEmployee: zCentsString,
    ahlEmployee: zCentsString,
    ahlEmployer: zCentsString,
    taxablePay: zCentsString.meta({
      description:
        "taxableGross − NSSF − SHIF − housing levy. **The three statutory employee contributions are ALLOWABLE DEDUCTIONS against taxable pay** under the Tax Laws (Amendment) Act 2024 — they reduce the income PAYE is computed on, they are NOT reliefs against the tax. A deduction saves tax at the marginal rate; a relief saves it shilling for shilling, so putting them in the wrong place mis-states PAYE for every employee.",
    }),
    payeBeforeRelief: zCentsString.meta({ description: "PAYE from the bands, each band's own portion rounded once." }),
    personalReliefApplied: zCentsString.meta({
      description: "Capped at payeBeforeRelief: a relief reduces tax to zero, it never becomes a refund.",
    }),
    paye: zCentsString,
    totalEmployeeDeductions: zCentsString.meta({ description: "NSSF + SHIF + housing levy + PAYE (CHECK-enforced)." }),
    netPay: zCentsString.meta({ description: "grossPay − totalEmployeeDeductions (CHECK-enforced)." }),
    createdAt: zTimestamp,
    earnings: z.array(zPayslipEarning).meta({
      description:
        "The earnings as they stood WHEN THE RUN WAS COMPUTED — copied, not referenced. A payslip that read through to the live employee record would silently restate itself after a salary revision, so last year's payslip would stop agreeing with last year's journal entry and with what the employee was actually paid.",
    }),
  })
  .meta({
    id: "Payslip",
    description:
      "One employee's computation for one run. EVERY intermediate figure is stored, not just the net: a payslip has to be defensible to the employee and to KRA years later, and recomputing it then would need the engine, the employee's terms AND the schedule exactly as they were. Frozen by a database trigger the moment its run leaves DRAFT.",
  });

export const zPayrollRunTotals = z.object({
  grossPay: zCentsString,
  employerContributions: zCentsString.meta({ description: "Employer NSSF + employer housing levy — the cost ON TOP of gross." }),
  paye: zCentsString,
  nssfTotal: zCentsString.meta({ description: "Employee + employer, as remitted to NSSF." }),
  shifTotal: zCentsString,
  housingLevyTotal: zCentsString.meta({ description: "Employee + employer." }),
  netPay: zCentsString,
  employeeCount: z.number().int(),
});

export const zPayrollRun = z
  .object({
    id: z.string(),
    runNumber: z.number().int(),
    periodYear: z.number().int(),
    periodMonth: z.number().int(),
    status: zPayrollRunStatus.meta({
      description:
        "DRAFT (computed, NOTHING posted, freely recomputable) -> APPROVED -> POSTED -> PAID. CANCELLED is reachable only before posting. **The accrual is booked ONLY on the APPROVED -> POSTED transition**, which is why a DRAFT can be recomputed as often as the payroll officer likes. **PAID means the NET PAY has been settled** out of 2120 by the run's one net-pay settlement (Task 8.2) — it says nothing about the four statutory heads, which are remitted on their own calendar and read from the run's remittances. PAID and CANCELLED are terminal.",
    }),
    payDate: zTimestamp.meta({ description: "**The accrual entry is dated to it**, because that is the date the obligation is settled against." }),
    statutoryScheduleId: z.string(),
    statutoryScheduleLabel: z.string().meta({
      description: "WHICH ruleset computed this run. Immutable once set: a payslip can only be re-derived if the rates it used are knowable.",
    }),
    journalEntryId: z.string().nullable().meta({ description: "The accrual entry, set on posting and never again." }),
    createdById: z.string(),
    approvedById: z.string().nullable(),
    postedAt: zTimestampNullable,
    notes: z.string().nullable(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
    totals: zPayrollRunTotals.meta({
      description: "Derived from the payslips rather than stored, so the report, the journal entry and the payslips are necessarily consistent.",
    }),
  })
  .meta({
    id: "PayrollRun",
    description:
      "One month's payroll. At most ONE non-CANCELLED run per calendar month (a partial unique index): two live payrolls for one month would double the salary expense, double what every statutory head is owed, and create two net-pay obligations for the same work.",
  });

export const zPayrollRunDetail = zPayrollRun
  .extend({ payslips: z.array(zPayslip) })
  .meta({ id: "PayrollRunDetail" });

// --- Payroll settlement & filing (Module 8, Task 8.2) -----------------------

export const zNetPayPaymentLine = z.object({
  id: z.string(),
  payslipId: z.string(),
  employeeId: z.string(),
  employeeNumber: z.number().int(),
  employeeName: z.string(),
  amount: zCentsString.meta({ description: "EXACTLY the payslip's net pay — a database trigger refuses any other figure." }),
  method: zEmployeePaymentMethod.meta({
    description:
      "SNAPSHOT of how this employee is paid, taken at settlement. Recorded for the bank payment file a later task builds; the ledger is NOT split by it.",
  }),
  bankName: z.string().nullable(),
  bankAccount: z.string().nullable(),
});

export const zNetPayPayment = z
  .object({
    id: z.string(),
    payrollRunId: z.string(),
    runNumber: z.number().int(),
    periodYear: z.number().int(),
    periodMonth: z.number().int(),
    paymentDate: zTimestamp.meta({ description: "The date the money left. The settlement entry is dated to it." }),
    method: zPayrollSettlementMethod.meta({
      description:
        "Selects the credit account: CASH -> 1000, BANK -> 1020, MPESA -> 1010. **MPESA RECORDS, IT DOES NOT DISBURSE** — there is no B2C payout.",
    }),
    debitAccountCode: z.string().meta({ description: "Always 2120 Net Salaries Payable." }),
    creditAccountCode: z.string(),
    totalNet: zCentsString.meta({
      description:
        "Σ the run's payslip net pay — DERIVED by the server, never accepted from the client, and pinned at COMMIT by a deferred constraint to the payslips, to the lines and to the 2120 debit of the entry.",
    }),
    reference: z.string().nullable(),
    notes: z.string().nullable(),
    journalEntryId: z.string().nullable().meta({
      description: "The `Dr 2120 / Cr cash` entry. NULL only when the run's net total is zero, which posts nothing.",
    }),
    createdById: z.string(),
    createdAt: zTimestamp,
    lines: z.array(zNetPayPaymentLine).meta({
      description: "ONE audit line per payslip of the run — every employee is accounted for, including one whose net is zero.",
    }),
  })
  .meta({
    id: "NetPayPayment",
    description:
      "The settlement of ONE run's net pay — exactly one per run, IMMUTABLE once written. It posts `Dr 2120 Net Salaries Payable / Cr 1000|1020|1010` and moves the run POSTED -> PAID in the same transaction. It touches no stock table, no 1200, no revenue and no expense account: the cost was recognised by the accrual.",
  });

export const zStatutoryRemittance = z
  .object({
    id: z.string(),
    statutoryType: zStatutoryType,
    authority: z.string().meta({ description: "KRA (PAYE, Housing Levy), NSSF, or SHA (SHIF)." }),
    debitAccountCode: z.string().meta({ description: "2200 PAYE, 2210 NSSF, 2220 SHA or 2230 Housing Levy." }),
    creditAccountCode: z.string(),
    amount: zCentsString,
    remittanceDate: zTimestamp.meta({ description: "The date the money left. The remittance entry is dated to it." }),
    method: zPayrollSettlementMethod,
    reference: z.string().nullable().meta({ description: "The authority's own payment reference (KRA PRN, NSSF or SHA receipt)." }),
    notes: z.string().nullable(),
    payrollRunId: z.string().nullable().meta({
      description: "The run this remittance is attributed to, if any. A remittance may also stand untagged — arrears or a consolidation.",
    }),
    payrollRunNumber: z.number().int().nullable(),
    journalEntryId: z.string(),
    createdById: z.string(),
    createdAt: zTimestamp,
  })
  .meta({
    id: "StatutoryRemittance",
    description:
      "One statutory head remitted to its authority, posting `Dr <head> / Cr cash`. IMMUTABLE. **It may never exceed what is owed**: the head's GL credit balance, and — when tagged to a run — what that run's accrual credited to the head. Both are refused by the service and by a deferred database constraint.",
  });

const zEmployerHeader = z.object({
  name: z.string(),
  kraPin: z.string().nullable().meta({ description: "The business's own KRA PIN, from its business profile." }),
});

const zRunHeader = z.object({
  id: z.string(),
  runNumber: z.number().int(),
  periodYear: z.number().int(),
  periodMonth: z.number().int(),
  status: zPayrollRunStatus,
  payDate: zTimestamp,
});

export const zPayslipDocument = z
  .object({
    documentType: z.literal("PAYSLIP"),
    employer: zEmployerHeader,
    payslipId: z.string(),
    run: zRunHeader.extend({ statutoryScheduleLabel: z.string() }),
    employee: z.object({
      id: z.string(),
      employeeNumber: z.number().int(),
      name: z.string(),
      nationalId: z.string().nullable(),
      kraPin: z.string().nullable(),
      nssfNumber: z.string().nullable(),
      shifNumber: z.string().nullable(),
    }),
    earnings: z.array(zPayslipEarning).meta({
      description: "Basic salary then each allowance, AS SNAPSHOTTED when the run was computed — never the employee's live terms.",
    }),
    grossPay: zCentsString,
    taxableGross: zCentsString,
    deductions: z.object({
      nssf: zCentsString,
      nssfTier1: zCentsString,
      nssfTier2: zCentsString,
      shif: zCentsString,
      housingLevy: zCentsString,
      paye: zCentsString,
      total: zCentsString,
    }),
    tax: z.object({
      taxablePay: zCentsString.meta({ description: "Taxable gross less NSSF, SHIF and the levy — allowable deductions, not reliefs." }),
      payeBeforeRelief: zCentsString,
      personalReliefApplied: zCentsString,
      paye: zCentsString,
    }),
    netPay: zCentsString,
    employerContributions: z.object({
      nssf: zCentsString,
      housingLevy: zCentsString,
      total: zCentsString,
    }),
    payment: z.object({
      status: z.enum(["PAID", "UNPAID"]),
      paymentDate: zTimestampNullable,
      settlementMethod: zPayrollSettlementMethod.nullable(),
      employeeMethod: zEmployeePaymentMethod.nullable(),
      amount: zCentsStringNullable,
    }),
  })
  .meta({
    id: "PayslipDocument",
    description:
      "A structured payslip, rendered and printed by the frontend (no PDF here). **Nothing is recomputed**: every figure is the stored payslip snapshot, frozen since the run left DRAFT, so a reprint can never disagree with the accrual.",
  });

const zMissingIdentifier = z.object({
  employeeId: z.string(),
  employeeNumber: z.number().int(),
  employeeName: z.string(),
  field: z.enum(["kraPin", "nssfNumber", "shifNumber"]),
});

const zScheduleTieOut = {
  authority: z.string(),
  accountCode: z.string(),
  total: zCentsString.meta({ description: "Σ of the schedule's amount column — what would be filed." }),
  payslipTotal: zCentsString.meta({ description: "Σ of the payslip column(s), summed independently of the rows." }),
  glCredited: zCentsStringNullable.meta({ description: "What the run's ACCRUAL ENTRY credited to the head. NULL before posting." }),
  remitted: zCentsString.meta({ description: "Remittances tagged to this run for the head." }),
  outstanding: zCentsStringNullable,
  reconciles: z.boolean().meta({ description: "total == payslipTotal == glCredited. Always false before posting." }),
  missingIdentifiers: z.array(zMissingIdentifier).meta({
    description: "Employees missing the identifier this authority files by. Flagged, not fatal — but a schedule with any is not fileable.",
  }),
};

const zEmployeeRef = {
  employeeId: z.string(),
  employeeNumber: z.number().int(),
  employeeName: z.string(),
};

export const zStatutorySummary = z
  .object({
    employer: zEmployerHeader,
    run: zRunHeader,
    paye: z
      .object({
        ...zScheduleTieOut,
        rows: z.array(
          z.object({
            ...zEmployeeRef,
            kraPin: z.string().nullable(),
            grossPay: zCentsString,
            taxablePay: zCentsString,
            payeBeforeRelief: zCentsString,
            personalReliefApplied: zCentsString,
            paye: zCentsString,
          }),
        ),
        totals: z.object({
          grossPay: zCentsString,
          taxablePay: zCentsString,
          payeBeforeRelief: zCentsString,
          personalReliefApplied: zCentsString,
          paye: zCentsString,
        }),
      })
      .meta({ description: "PAYE in the P10 shape: per employee KRA PIN, taxable pay and PAYE. Ties to 2200." }),
    nssf: z
      .object({
        ...zScheduleTieOut,
        rows: z.array(
          z.object({
            ...zEmployeeRef,
            nssfNumber: z.string().nullable(),
            grossPay: zCentsString,
            tier1: zCentsString,
            tier2: zCentsString,
            employee: zCentsString,
            employer: zCentsString,
            total: zCentsString,
          }),
        ),
        totals: z.object({
          grossPay: zCentsString,
          tier1: zCentsString,
          tier2: zCentsString,
          employee: zCentsString,
          employer: zCentsString,
          total: zCentsString,
        }),
      })
      .meta({ description: "Per employee NSSF number, Tier I / Tier II, employee + employer. Ties to 2210." }),
    shif: z
      .object({
        ...zScheduleTieOut,
        rows: z.array(
          z.object({
            ...zEmployeeRef,
            shifNumber: z.string().nullable(),
            grossPay: zCentsString,
            shif: zCentsString,
          }),
        ),
        totals: z.object({ grossPay: zCentsString, shif: zCentsString }),
      })
      .meta({ description: "Per employee SHIF number, gross and contribution. Ties to 2220." }),
    housingLevy: z
      .object({
        ...zScheduleTieOut,
        rows: z.array(
          z.object({
            ...zEmployeeRef,
            kraPin: z.string().nullable(),
            grossPay: zCentsString,
            employee: zCentsString,
            employer: zCentsString,
            total: zCentsString,
          }),
        ),
        totals: z.object({
          grossPay: zCentsString,
          employee: zCentsString,
          employer: zCentsString,
          total: zCentsString,
        }),
      })
      .meta({ description: "Per employee gross, employee 1.5% and employer 1.5%. Filed with KRA. Ties to 2230." }),
    grandTotal: zCentsString.meta({ description: "Σ of the four heads." }),
    fileable: z.boolean().meta({
      description: "Every schedule reconciles to its payslips AND to the ledger, and no employee is missing an identifier it needs.",
    }),
  })
  .meta({
    id: "StatutorySummary",
    description:
      "The four statutory filing schedules of one run. **Read-only and recomputes nothing** — each is summed from the stored payslip columns and tied BOTH to those columns and to what the run's accrual entry credited to the head. File formats (iTax P10, NSSF and SHA uploads) and direct filing are deferred; this is the data they are generated from.",
  });

const zMusterAmounts = {
  grossPay: zCentsString,
  taxableGross: zCentsString,
  nssf: zCentsString,
  shif: zCentsString,
  housingLevy: zCentsString,
  paye: zCentsString,
  totalDeductions: zCentsString,
  netPay: zCentsString,
  employerNssf: zCentsString,
  employerHousingLevy: zCentsString,
  employerCost: zCentsString.meta({ description: "gross + the employer's NSSF and levy — what employing this person cost." }),
};

export const zMusterRoll = z
  .object({
    employer: zEmployerHeader,
    run: zRunHeader,
    rows: z.array(z.object({ payslipId: z.string(), ...zEmployeeRef, ...zMusterAmounts })),
    totals: z.object(zMusterAmounts),
    employeeCount: z.number().int(),
    glNetCredited: zCentsStringNullable.meta({ description: "What the accrual credited to 2120. NULL before posting." }),
    reconciles: z.boolean().meta({
      description:
        "Every row and the totals satisfy gross − deductions == net and deductions == NSSF + SHIF + levy + PAYE, and once posted the net total equals the 2120 credit.",
    }),
  })
  .meta({
    id: "MusterRoll",
    description: "Every payslip of a run, gross through deductions to net, with column totals. Read-only; recomputes nothing.",
  });

// --- Financial reporting (Module 13) ----------------------------------------

export const zReportPeriod = z.object({
  from: zTimestamp.meta({ description: "First business date of the period (inclusive), by entryDate." }),
  to: zTimestamp.meta({ description: "Last business date of the period (inclusive), by entryDate." }),
});

export const zReportLine = z.object({
  code: z.string().nullable().meta({ description: "The account code, or null for a DERIVED line such as current-year earnings." }),
  name: z.string(),
  amount: zCentsString.meta({
    description: "Presented amount. Credit-nature sections read positive; contra accounts (1590, 3100, 4900) present as negative lines inside their section.",
  }),
  comparativeAmount: zCentsStringNullable,
});

export const zReportSection = z.object({
  lines: z.array(zReportLine),
  total: zCentsString,
  comparativeTotal: zCentsStringNullable,
});

export const zReportFigure = z.object({ amount: zCentsString, comparativeAmount: zCentsStringNullable });

export const zIncomeStatement = z
  .object({
    period: zReportPeriod,
    comparativePeriod: zReportPeriod.nullable(),
    revenue: zReportSection.meta({ description: "4000/4100/4200, less 4900 returns (contra)." }),
    costOfSales: zReportSection,
    grossProfit: zReportFigure,
    operatingExpenses: zReportSection,
    netProfit: zReportFigure,
  })
  .meta({
    id: "IncomeStatement",
    description: "Revenue − cost of sales = gross profit; − operating expenses = net profit. Movements by entryDate over the period, with the immediately preceding period of equal length as the comparative.",
  });

export const zBalanceSheet = z
  .object({
    asOf: zTimestamp,
    comparativeAsOf: zTimestampNullable.meta({ description: "The end of the month before asOf's month." }),
    financialYearStart: zTimestamp.meta({ description: "The financial year is the calendar year (1 January) in this build." }),
    assets: z.object({ current: zReportSection, nonCurrent: zReportSection, total: zReportFigure }),
    liabilities: z.object({ current: zReportSection, longTerm: zReportSection, total: zReportFigure }),
    equity: zReportSection.meta({
      description:
        "Capital − drawings + retained earnings as posted, PLUS the accumulated net income (no closing entries exist, so profit is derived into equity) split into prior financial years and current-year earnings.",
    }),
    liabilitiesAndEquity: zReportFigure,
    balances: z.literal(true).meta({ description: "Assets == liabilities + equity to the cent on both columns; the report fails rather than returning otherwise." }),
  })
  .meta({ id: "BalanceSheet", description: "Statement of financial position as at a business date, by entryDate." });

export const zCashFlowStatement = z
  .object({
    period: zReportPeriod,
    comparativePeriod: zReportPeriod.nullable(),
    netProfit: zReportFigure,
    nonCashAdjustments: zReportSection.meta({ description: "The period movement of 1590 accumulated depreciation." }),
    workingCapitalChanges: zReportSection.meta({ description: "Every current asset and current liability outside the cash set. Cash effect = −(Σdebit − Σcredit)." }),
    operatingActivities: zReportFigure,
    investingActivities: zReportSection,
    financingActivities: zReportSection.meta({ description: "Loans, capital, drawings and any direct posting to retained earnings." }),
    netChangeInCash: zReportFigure,
    openingCash: zReportFigure.meta({ description: "Cash & equivalents {1000, 1010, 1015, 1020} the day before the period." }),
    closingCash: zReportFigure,
    tiesOut: z.literal(true).meta({ description: "Net change in cash == closing − opening cash on both columns; the report fails rather than returning otherwise." }),
  })
  .meta({ id: "CashFlowStatement", description: "Indirect-method cash flow over a period, by entryDate." });

export const zTrialBalanceReport = z
  .object({
    asOf: zTimestamp,
    comparativeAsOf: zTimestampNullable,
    rows: z.array(
      z.object({
        code: z.string(),
        name: z.string(),
        accountClass: zAccountClass,
        section: z.string().meta({ description: "The statement section report-classification.ts places this account in." }),
        debit: zCentsString,
        credit: zCentsString,
        comparativeDebit: zCentsStringNullable,
        comparativeCredit: zCentsStringNullable,
      }),
    ),
    totals: z.object({
      debit: zCentsString,
      credit: zCentsString,
      comparativeDebit: zCentsStringNullable,
      comparativeCredit: zCentsStringNullable,
    }),
    balanced: z.literal(true),
  })
  .meta({ id: "TrialBalanceReport", description: "Every account's balance on its side as at a business date; Σ debits == Σ credits asserted." });

export const zVatReturn = z
  .object({
    period: zReportPeriod,
    taxRegime: zTenantTaxRegime,
    isVatRegistered: z.boolean(),
    presentation: z.enum(["VAT_RETURN", "TOT_POSITION"]).meta({
      description: "VAT_RETURN for a VAT-registered tenant; TOT_POSITION for a Turnover Tax tenant, whose VAT figures are still shown but are anomalies.",
    }),
    vat: z.object({
      outputVat: z.object({ charged: zCentsString, reversed: zCentsString, net: zCentsString }),
      inputVat: z.object({ claimed: zCentsString, reversed: zCentsString, net: zCentsString }),
      netVat: zCentsString.meta({ description: "output.net − input.net. Positive = payable to KRA." }),
      position: z.enum(["PAYABLE", "REFUNDABLE", "NIL"]),
      salesByCode: z
        .object({
          standardRated: z.object({ turnover: zCentsString, vat: zCentsString }).meta({ description: "KRA code B. Its VAT ties to outputVat.net when every 2100 movement came from a sale." }),
          zeroRated: z.object({ turnover: zCentsString }).meta({ description: "KRA code C — vatable at 0%." }),
          exempt: z.object({ turnover: zCentsString }).meta({ description: "KRA code A — outside VAT." }),
          nonVat: z.object({ turnover: zCentsString }).meta({ description: "KRA code D — sales made while not VAT-registered." }),
        })
        .meta({ description: "Net sales turnover by the KRA code each line was charged under, posted less voided in the period (Task 3B.1)." }),
      taxablePurchases: zCentsString,
    }),
    turnoverTax: z
      .object({
        accountCode: z.string(),
        ratePercent: zDecimalStringNullable.meta({ description: "The TOT rate in force at the period's end." }),
        turnover: zCentsString.meta({ description: "Net sales that accrued TOT in the period (posted less voided)." }),
        accrued: zCentsString.meta({ description: "Σ Sale.totAccrued, posted less voided in the period." }),
        ledgerMovement: zCentsString.meta({ description: "The period's credit movement of 2110 TOT Payable." }),
        closingBalance: zCentsString,
        reconciles: z.boolean().meta({ description: "accrued == ledgerMovement." }),
      })
      .meta({ description: "The COMPUTED Turnover Tax position (Task 3B.2): accrued per sale for a TURNOVER_TAX tenant, tied to the 2110 movement." }),
    anomalies: z.array(z.object({ code: z.string(), message: z.string(), amount: zCentsString })).meta({
      description: "Explicit, named discrepancies between the tenant's regime and what the ledger carries. Never hidden.",
    }),
  })
  .meta({ id: "VatReturn", description: "VAT return or TOT position for a period, from net period movements by entryDate." });

export const zControlReconciliation = z
  .object({
    basis: z.literal("CURRENT").meta({
      description: "The subledgers are current-state projections, so the GL side covers every posted entry. There is no as-at control reconciliation.",
    }),
    items: z.array(
      z.object({
        control: z.enum(["INVENTORY", "ACCOUNTS_RECEIVABLE", "ACCOUNTS_PAYABLE", "GRNI"]),
        accountCode: z.string(),
        glBalance: zCentsString,
        subledgerLabel: z.string(),
        subledger: zCentsString,
        residuals: z.array(z.object({ label: z.string(), amount: zCentsString })),
        unexplained: zCentsString.meta({ description: "glBalance − subledger − Σ residuals. Must be 0." }),
        reconciles: z.boolean(),
      }),
    ),
    allReconcile: z.boolean(),
  })
  .meta({ id: "ControlReconciliation", description: "Each subledger tied to its GL control account, with the known structural residuals as named lines." });

// --- Mentorship (Module 14, Task 14.1) ---------------------------------------

export const zMentorshipEngagementStatus = z.enum(MentorshipEngagementStatus).meta({
  description:
    "INVITED (an admin proposed it; the mentor has NO access) -> ACTIVE (the business owner consented) | ENDED; ACTIVE -> ENDED. ENDED is terminal; re-engaging is a new engagement and a new consent.",
});

export const zMentorshipEngagement = z
  .object({
    id: z.string(),
    mentorId: z.string(),
    mentorName: z.string(),
    mentorRole: zUserRole,
    tenantId: z.string(),
    businessName: z.string(),
    status: zMentorshipEngagementStatus,
    invitedById: z.string(),
    consentGivenAt: zTimestampNullable.meta({ description: "When the business owner consented. Set once, with consentByUserId, as the engagement becomes ACTIVE." }),
    consentByUserId: z.string().nullable(),
    startedAt: zTimestampNullable,
    endedAt: zTimestampNullable,
    endedReason: z.string().nullable(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({
    id: "MentorshipEngagement",
    description:
      "One mentor-to-business relationship, held at PLATFORM level. It is the gate for the ONE sanctioned cross-tenant read: a mentor reads a business's figures only while the engagement is ACTIVE (consented), the business is resolved FROM this record and never from a request, and every read is logged.",
  });

export const zMentorshipAccessLogEntry = z
  .object({
    id: z.string(),
    engagementId: z.string(),
    mentorId: z.string(),
    mentorName: z.string(),
    tenantId: z.string(),
    resource: z.string().meta({ description: "What was read, e.g. \"snapshot\"." }),
    viewedAt: zTimestamp,
  })
  .meta({ id: "MentorshipAccessLogEntry", description: "One mentor read of a business's data. Append-only: the database refuses any edit or deletion." });

export const zMentorSnapshot = z
  .object({
    engagementId: z.string(),
    tenantId: z.string(),
    businessName: z.string(),
    period: z.object({ from: zTimestamp, to: zTimestamp }),
    revenue: zCentsString.meta({ description: "Month-to-date revenue (net of returns), from the Module 13 income statement." }),
    grossProfit: zCentsString,
    netProfit: zCentsString,
    cashPosition: zCentsString.meta({ description: "Cash & equivalents at the end of the period, from the Module 13 cash flow statement." }),
  })
  .meta({
    id: "MentorSnapshot",
    description:
      "A minimal engagement-scoped read (Task 14.1): this month's revenue, gross and net profit, and the cash position of the engaged business — computed by the SAME Module 13 engine as the owner's reports, inside a READ ONLY transaction, and logged.",
  });

// ---------------------------------------------------------------------------
// Mentoring records (Module 14, Task 14.2)
// ---------------------------------------------------------------------------

export const zGoalStatus = z.enum(GoalStatus).meta({
  description: "OPEN / ON_TRACK / AT_RISK (freely movable) -> MET | MISSED, both terminal.",
});

export const zIndicatorSourceKey = z.enum(IndicatorSourceKey).meta({
  description:
    "What the indicator measures, each computed live from the Module 13 engine, current month to date. MONEY (target/actual in cents): MONTHLY_REVENUE, NET_PROFIT, CASH_POSITION (cash & equivalents 1000/1010/1015/1020 at today), RECEIVABLES_OUTSTANDING (1100 at today). RATE (2-place decimal string): GROSS_MARGIN_PCT (gross ÷ revenue × 100), SALES_GROWTH_PCT (vs the preceding equal-length period), INVENTORY_TURNOVER (cost of sales ÷ average of opening and closing 1200, times).",
});

export const zActionParty = z.enum(ActionParty);
export const zActionItemStatus = z.enum(ActionItemStatus).meta({
  description: "OPEN -> DONE (stamps completedAt) | CANCELLED; both terminal.",
});

export const zMentorshipGoal = z
  .object({
    id: z.string(),
    engagementId: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    targetValue: zCentsStringNullable,
    targetMetric: z.string().nullable(),
    targetDate: zTimestampNullable,
    status: zGoalStatus,
    createdById: z.string(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "MentorshipGoal", description: "A goal agreed within an engagement (platform-level; the business's books are untouched)." });

export const zMentorshipIndicator = z
  .object({
    id: z.string(),
    engagementId: z.string(),
    name: z.string(),
    sourceKey: zIndicatorSourceKey,
    kind: z.enum(["AMOUNT", "RATE"]),
    targetAmount: zCentsStringNullable,
    targetRate: zDecimalStringNullable,
    note: z.string().nullable(),
    createdById: z.string(),
    createdAt: zTimestamp,
  })
  .meta({
    id: "MentorshipIndicator",
    description:
      "An agreed KPI and its TARGET. Its actual is NEVER stored — read it from GET /v1/mentorship/indicators/{id}/actual. Immutable once agreed: a changed target is a new indicator.",
  });

export const zMentorshipIndicatorActual = z
  .object({
    indicatorId: z.string(),
    engagementId: z.string(),
    businessName: z.string(),
    name: z.string(),
    sourceKey: zIndicatorSourceKey,
    kind: z.enum(["AMOUNT", "RATE"]),
    period: z.object({ from: zTimestamp, to: zTimestamp }),
    targetAmount: zCentsStringNullable,
    targetRate: zDecimalStringNullable,
    actualAmount: zCentsStringNullable,
    actualRate: zDecimalStringNullable,
    unavailableReason: z.string().nullable(),
    computedAt: zTimestamp,
  })
  .meta({
    id: "MentorshipIndicatorActual",
    description:
      "An indicator's actual, computed NOW by the Module 13 engine through the read-only access gate (and logged for the owner) — the same figure the owner's own report shows. Never stored.",
  });

export const zMentorshipActionItem = z
  .object({
    id: z.string(),
    engagementId: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    responsibleParty: zActionParty,
    dueDate: zTimestampNullable,
    status: zActionItemStatus,
    completedAt: zTimestampNullable,
    completedById: z.string().nullable().meta({ description: "Who marked it DONE: the mentor, or the business owner for an ENTREPRENEUR item. Null on a completion made before Task 14.3." }),
    createdById: z.string(),
    createdAt: zTimestamp,
    updatedAt: zTimestamp,
  })
  .meta({ id: "MentorshipActionItem", description: "A concrete action owned by the mentor or the entrepreneur." });

export const zMentorshipSession = z
  .object({
    id: z.string(),
    engagementId: z.string(),
    sessionDate: zTimestamp,
    summary: z.string(),
    observations: z.string().nullable(),
    commitments: z.string().nullable(),
    createdById: z.string(),
    createdAt: zTimestamp,
  })
  .meta({ id: "MentorshipSession", description: "A dated coaching check-in. Immutable once recorded." });

// ---------------------------------------------------------------------------
// Mentorship views (Module 14, Task 14.3)
// ---------------------------------------------------------------------------

export const zIndicatorStanding = z.enum(["ON_TARGET", "OFF_TARGET", "UNAVAILABLE"]).meta({
  description:
    "The live actual against the target. RECEIVABLES_OUTSTANDING is on target at or BELOW its target; every other indicator at or ABOVE. UNAVAILABLE when the actual is undefined (a zero denominator).",
});

const zPeriodRange = z.object({ from: zTimestamp, to: zTimestamp });

const zActionPlan = z.object({
  open: z.array(zMentorshipActionItem),
  closed: z.array(zMentorshipActionItem).meta({ description: "DONE and CANCELLED items." }),
});

export const zMentorshipDashboard = z
  .object({
    engagement: zMentorshipEngagement,
    period: zPeriodRange,
    indicators: z.array(
      zMentorshipIndicator.extend({
        actualAmount: zCentsStringNullable,
        actualRate: zDecimalStringNullable,
        unavailableReason: z.string().nullable(),
        standing: zIndicatorStanding,
      }),
    ),
    goals: z.array(zMentorshipGoal),
    actionItems: zActionPlan,
    recentSessions: z.array(zMentorshipSession),
    sessionCount: z.number().int(),
    computedAt: zTimestamp,
  })
  .meta({
    id: "MentorshipDashboard",
    description:
      "One ACTIVE engagement composed for its mentor. Every actual is computed live by the Module 13 engine in ONE read-only gate opening, logged for the owner; nothing is stored.",
  });

export const zMentorCohort = z
  .object({
    members: z.array(
      z.object({
        engagement: zMentorshipEngagement,
        period: zPeriodRange,
        revenue: zCentsString.meta({ description: "Month-to-date revenue, from the business's own income statement." }),
        cashPosition: zCentsString.meta({ description: "Cash & equivalents (1000/1010/1015/1020) as at today." }),
        grossMarginPct: zDecimalStringNullable,
        grossMarginUnavailableReason: z.string().nullable(),
        openActionItems: z.number().int(),
      }),
    ),
    computedAt: zTimestamp,
  })
  .meta({
    id: "MentorCohort",
    description:
      "The mentor's ACTIVE engagements with headline KPIs — each business read through its OWN gate call (its own schema, its own logged read). Figures are never combined across businesses.",
  });

export const zOwnerEngagementView = z
  .object({
    engagement: zMentorshipEngagement,
    goals: z.array(zMentorshipGoal),
    indicators: z.array(zMentorshipIndicator),
    actionItems: zActionPlan,
    sessions: z.array(zMentorshipSession),
    accessLog: z.array(zMentorshipAccessLogEntry),
  })
  .meta({
    id: "OwnerEngagementView",
    description:
      "The business owner's reciprocal view of one engagement on their own business: everything the mentor set on it, and the full log of every read of the business's books.",
  });
