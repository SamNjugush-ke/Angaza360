-- ===========================================================================
-- HAND-WRITTEN — closing a hole in migration 0018's payment guarantee.
--
-- There is NO datamodel change here: no table, no column, no enum, no index. This
-- migration replaces one trigger function and adds one deferred constraint trigger.
--
-- THE HOLE. 0018's `payment_fully_allocated_check` was attached ONLY to
-- `supplier_payment_allocations`. A trigger on the allocations table cannot fire for
-- a payment that has NO allocation rows, so `INSERT INTO supplier_payments` with
-- nothing allocated was accepted by the database — cash recorded as leaving the
-- business with no invoice reduced, which leaves Accounts Payable overstated while
-- the aging report keeps chasing a supplier who has been paid. That is exactly the
-- inconsistency 0018(k) set out to make impossible. The service does refuse it, but
-- the service check is ergonomics and the constraint is the guarantee (the engineering ledger
-- "Working Practices That Are Now Law").
--
-- It was found by the ADVERSARIAL half of Task 5.2's acceptance — raw SQL attacking
-- the rule from outside the service layer — which is precisely why that half is
-- mandatory and not optional. 0018 already applies the same both-sides treatment to
-- the bill-side check (`bill_paid_matches_allocations_on_allocation` AND
-- `..._on_bill`) for this reason; this completes the symmetry for payments.
--
-- WHY A NEW MIGRATION RATHER THAN AN EDIT TO 0018: 0018 is already recorded in both
-- tenants' `_tenant_migrations` ledgers, and the recorded checksum is the guard
-- against an edited migration. A correction is therefore a NEW migration, never a
-- rewrite of one a tenant has already applied — the same discipline as correcting a
-- posted journal entry with a reversal instead of an edit.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) THE FUNCTION MUST WORK FROM EITHER SIDE.
--
-- 0018's body read `NEW."paymentId"`, which is correct on the allocations table and
-- does not exist on `supplier_payments` — binding it to the payment table unchanged
-- raised `record "new" has no field "paymentId"` on every payment. So it now resolves
-- the payment id from `TG_TABLE_NAME`, exactly as
-- `assert_bill_paid_matches_allocations` (0018) already does for its two bindings.
--
-- `TG_OP` is branched explicitly rather than relying on `COALESCE(NEW, OLD)`:
-- referencing a field of NEW in a DELETE trigger is not something to depend on, and
-- the existing ledger triggers (0003/0004) set the precedent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_payment_fully_allocated() RETURNS trigger AS $$
DECLARE
  v_schema     text := TG_TABLE_SCHEMA;
  v_payment_id text;
  v_number     integer;
  v_amount     bigint;
  v_allocated  bigint;
BEGIN
  IF TG_TABLE_NAME = 'supplier_payments' THEN
    -- A deleted payment has nothing left to validate, and the immutability trigger
    -- refuses the delete anyway.
    IF TG_OP = 'DELETE' THEN
      RETURN NULL;
    END IF;
    v_payment_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    v_payment_id := OLD."paymentId";
  ELSE
    v_payment_id := NEW."paymentId";
  END IF;

  EXECUTE format('SELECT "paymentNumber", "amount" FROM %I.supplier_payments WHERE "id" = $1', v_schema)
    INTO v_number, v_amount USING v_payment_id;

  -- Parent payment gone: nothing to validate (it cannot happen while the
  -- immutability trigger stands, but the guard costs nothing).
  IF v_number IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SELECT COALESCE(SUM("amount"), 0) FROM %I.supplier_payment_allocations WHERE "paymentId" = $1', v_schema)
    INTO v_allocated USING v_payment_id;

  IF v_allocated <> v_amount THEN
    RAISE EXCEPTION
      'Supplier payment PAY-% is % cents but % cents are allocated to invoices (difference % cents). Every shilling of a payment must be pointed at a bill: there is no on-account supplier balance.',
      v_number, v_amount, v_allocated, (v_amount - v_allocated);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- (b) THE MISSING BINDING: a payment is checked from its OWN side too.
--
-- DEFERRABLE INITIALLY DEFERRED, so the ordinary write — insert the payment, then
-- insert its allocations — still succeeds because the rows are all present by
-- COMMIT, while a transaction that would leave a payment unallocated fails
-- atomically at COMMIT. Identical mechanism to `journal_balance_check` (0003, made
-- schema-safe in 0004) and to 0018's two bill-side bindings.
-- ---------------------------------------------------------------------------
CREATE CONSTRAINT TRIGGER payment_fully_allocated_check_on_payment
  AFTER INSERT OR UPDATE ON supplier_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_payment_fully_allocated();
