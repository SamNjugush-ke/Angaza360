-- ===========================================================================
-- Task T-A6.2 — application actions on the ONE identity audit log. Values only.
-- ===========================================================================
ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_REJECTED';
