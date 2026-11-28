-- ===========================================================================
-- Task T-A5 — staff-management actions on the ONE identity audit log.
--
-- T-A4 created audit_logs; T-A5 only ADDS actions to its enum, here, in their own
-- migration — never a second audit table. (ALTER TYPE ... ADD VALUE: nothing in this
-- file uses the new values, which would be unusable until COMMIT — see the engineering ledger
-- "Working Practices".)
-- ===========================================================================
ALTER TYPE "AuditAction" ADD VALUE 'USER_INVITED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'ROLE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_REACTIVATED';
