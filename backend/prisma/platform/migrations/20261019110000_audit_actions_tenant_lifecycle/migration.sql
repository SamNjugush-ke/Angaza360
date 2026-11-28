-- ===========================================================================
-- Task T-A6.1 — tenant onboarding and lifecycle actions on the ONE identity audit log.
-- Values only; nothing here uses them (the engineering ledger "Working Practices").
-- ===========================================================================
ALTER TYPE "AuditAction" ADD VALUE 'TENANT_ONBOARDED';
ALTER TYPE "AuditAction" ADD VALUE 'TENANT_SUSPENDED';
ALTER TYPE "AuditAction" ADD VALUE 'TENANT_REACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'TENANT_DEACTIVATED';
