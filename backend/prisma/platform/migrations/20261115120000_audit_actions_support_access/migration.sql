-- ===========================================================================
-- M4.5 Wave 1 — support-access actions on the ONE identity audit log. Values only.
-- ===========================================================================
ALTER TYPE "AuditAction" ADD VALUE 'SUPPORT_ACCESS_GRANTED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPORT_ACCESS_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPORT_ACCESS_USED';
