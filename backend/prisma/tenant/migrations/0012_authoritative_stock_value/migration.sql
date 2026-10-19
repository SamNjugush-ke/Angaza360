-- AlterTable
ALTER TABLE "sale_lines" ADD COLUMN     "lineCogs" BIGINT;

-- ===========================================================================
-- HAND-WRITTEN INTEGRITY DDL — everything below this line is written by hand
-- and MUST NOT be regenerated or removed. All identifiers are unqualified and
-- resolve against the tenant search_path at runtime; the migration stays
-- schema-neutral (it neither creates a schema nor hard-codes a schema-qualified
-- prefix).
--
-- TASK 3.1-FIX — Product.stockValue is the AUTHORITATIVE carrying value.
-- It moves only by exact posted deltas and is never recomputed as
-- stockCount * avgCost; avgCost became a derived cache of stockValue /
-- stockCount. See the engineering ledger "Inventory Valuation Is Carrying-Value-
-- Authoritative".
-- ===========================================================================

-- (a) sale_lines."lineCogs" is the EXACT cost this line posted to the ledger —
-- the single valuation event, snapshotted on the source document. A void
-- reverses THIS figure rather than re-extending the rounded per-unit
-- "unitCogs", so account 1200 returns to exactly where it was even when the
-- average did not divide evenly. It is NULLABLE by the NULL-means-default rule:
-- rows written before this migration have no snapshot, and for them the posted
-- cost was exactly roundHalfUp(quantity * "unitCogs") because that is how the
-- pre-fix model valued every outbound movement. Those rows are read that way,
-- never backfilled — sale_lines are write-once (migration 0006) and a
-- historical financial row is not edited to suit a new column.

-- (b) THE ZERO INVARIANT, one-directional.
--     stockCount = 0  =>  stockValue = 0
-- Zero physical stock must carry exactly zero value: a "ghost balance" of a few
-- cents against nothing on the shelf is precisely the drift this task removed.
-- The service guarantees it by valuing a DEPLETING outbound movement (one that
-- takes the aggregate to zero) at the ENTIRE remaining stockValue rather than
-- at quantity * rate; this CHECK is the structural backstop behind that rule.
--
-- The CONVERSE IS DELIBERATELY NOT ENFORCED. stockValue = 0 with stockCount > 0
-- is LEGAL and must stay legal: donated, promotional and free-sample stock is
-- real inventory acquired at zero cost, and a zero-cost receipt is a valid
-- purchase. Writing this as an equivalence would reject that.
ALTER TABLE "products" ADD CONSTRAINT product_zero_stock_zero_value
  CHECK (NOT ("stockCount" = 0 AND "stockValue" <> 0));

-- If this constraint fails to apply on an existing tenant, that tenant is
-- carrying a ghost balance from the pre-fix valuation model. Do NOT weaken the
-- CHECK. Run `npm run inventory:rebuild-stock-value` first, which rebuilds each
-- product's stockValue from the immutable stock_movements history, and re-run
-- the migration.
