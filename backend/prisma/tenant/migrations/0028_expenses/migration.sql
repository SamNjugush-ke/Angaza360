-- ===========================================================================
-- 0028 — SIMPLE EXPENSE CAPTURE (Task T-A9). HAND-WRITTEN.
--
-- A thin record of one expense the business PAID — rent, airtime, fuel — whose financial
-- effect is ONE balanced journal entry posted through the ledger service in the SAME
-- transaction:   Dr <expense account 6xxx> / Cr <how it was paid: 1000 | 1010 | 1020>.
-- The row is the business document; the journal entry is the accounting. They are linked
-- one-to-one and both immutable: a mistake is VOIDED by a reversing entry, never edited.
--
-- DECIDED BY THE PRODUCT OWNER (recorded in the engineering ledger):
--   * PAID NOW ONLY — CASH, MPESA or BANK. Something bought on credit is a supplier bill
--     (Accounts Payable already takes EXPENSE lines and reconciles 2000); an "on account"
--     expense would credit 2000 with no bill behind it and break that reconciliation.
--   * NO INPUT VAT YET — the expense posts GROSS. Recognising input VAT here would widen
--     input-VAT recovery while the mixed-supplies apportionment watch item is open.
--     "vatInputCents" exists so enabling it later is a guard change, not a migration
--     across posted expenses, and the CHECK below pins it to 0 until then.
-- ===========================================================================

CREATE TYPE "ExpensePaymentMethod" AS ENUM ('CASH', 'MPESA', 'BANK');

CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "expenseDate" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "payee" TEXT,
    "description" TEXT NOT NULL,
    "paymentMethod" "ExpensePaymentMethod" NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "vatInputCents" BIGINT NOT NULL DEFAULT 0,
    "reference" TEXT,
    "journalEntryId" TEXT NOT NULL,
    "isVoided" BOOLEAN NOT NULL DEFAULT false,
    "voidedByEntryId" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "expenses_journalEntryId_key" ON "expenses"("journalEntryId");
CREATE UNIQUE INDEX "expenses_voidedByEntryId_key" ON "expenses"("voidedByEntryId");
CREATE INDEX "expenses_expenseDate_idx" ON "expenses"("expenseDate");
CREATE INDEX "expenses_category_idx" ON "expenses"("category");

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_fkey" FOREIGN KEY ("category") REFERENCES "accounts"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voidedByEntryId_fkey" FOREIGN KEY ("voidedByEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "expenses" ADD CONSTRAINT "expense_amount_positive" CHECK ("amountCents" > 0);

ALTER TABLE "expenses" ADD CONSTRAINT "expense_description_present" CHECK (btrim("description") <> '');

-- NO INPUT VAT ON AN EXPENSE (yet) — see the header. Fail-closed: any non-zero figure is
-- refused, whoever writes it.
ALTER TABLE "expenses" ADD CONSTRAINT "expense_input_vat_deferred" CHECK ("vatInputCents" = 0);

-- AN EXPENSE IS CHARGED TO AN OPERATING-EXPENSE ACCOUNT (6000–6999) THAT IS NOT WRITTEN
-- BY ANOTHER MODULE: 6020 Salaries & Wages and 6025 Employer Statutory Contributions are
-- payroll's (each ties to payslips), 6090 Depreciation is a non-cash book entry, and
-- 6110 Turnover Tax is accrued by the sale path. Cost of sales (5xxx) is never an expense.
ALTER TABLE "expenses" ADD CONSTRAINT "expense_category_is_operating_expense" CHECK (
  "category" ~ '^6[0-9]{3}$' AND "category" NOT IN ('6020', '6025', '6090', '6110')
);

-- VOID COHERENCE: voided exactly when it names its reversing entry and when.
ALTER TABLE "expenses" ADD CONSTRAINT "expense_void_coherent" CHECK (
  "isVoided" = ("voidedByEntryId" IS NOT NULL)
  AND "isVoided" = ("voidedAt" IS NOT NULL)
);

-- IMMUTABLE, BUT VOIDABLE ONCE. Born un-voided; the ONLY permitted change is the void
-- itself (isVoided false -> true with its reversing entry, time and reason); nothing else
-- ever changes, and an expense is never deleted.
CREATE OR REPLACE FUNCTION expense_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."isVoided" THEN
      RAISE EXCEPTION 'An expense is recorded un-voided; a void is a later, reversing act.';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Expense % cannot be deleted: void it, which posts a reversing entry.', OLD."id";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."expenseDate" IS DISTINCT FROM OLD."expenseDate"
     OR NEW."category" IS DISTINCT FROM OLD."category"
     OR NEW."payee" IS DISTINCT FROM OLD."payee"
     OR NEW."description" IS DISTINCT FROM OLD."description"
     OR NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod"
     OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
     OR NEW."vatInputCents" IS DISTINCT FROM OLD."vatInputCents"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId"
     OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Expense % is a posted record and cannot be edited; void it and record it again.', OLD."id";
  END IF;
  IF OLD."isVoided" THEN
    RAISE EXCEPTION 'Expense % is already voided, which is final.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER expense_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION expense_guard();
