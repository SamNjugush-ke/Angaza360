-- ===========================================================================
-- Task T-A6.3 — batch actions on the ONE identity audit log. Values only.
-- ===========================================================================
ALTER TYPE "AuditAction" ADD VALUE 'BATCH_UPLOADED';
ALTER TYPE "AuditAction" ADD VALUE 'BATCH_COMMITTED';
