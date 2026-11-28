-- ===========================================================================
-- M4.5 Wave 1 — MFA and forced-reset actions on the ONE identity audit log. Values only.
-- ===========================================================================
ALTER TYPE "AuditAction" ADD VALUE 'MFA_ENROLLED';
ALTER TYPE "AuditAction" ADD VALUE 'MFA_DISABLED';
ALTER TYPE "AuditAction" ADD VALUE 'MFA_RESET';
ALTER TYPE "AuditAction" ADD VALUE 'MFA_BACKUP_CODES_REGENERATED';
ALTER TYPE "AuditAction" ADD VALUE 'MFA_BACKUP_CODE_USED';
ALTER TYPE "AuditAction" ADD VALUE 'MFA_STEP_UP';
ALTER TYPE "AuditAction" ADD VALUE 'MFA_CHALLENGE_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_FORCED_RESET_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_ADMIN_RESET';
ALTER TYPE "AuditAction" ADD VALUE 'SESSION_REVOKED';
