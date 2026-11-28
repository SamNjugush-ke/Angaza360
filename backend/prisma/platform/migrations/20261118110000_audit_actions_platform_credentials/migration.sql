-- M4.5 Wave 5: managing Angaza's OWN notification credentials from the Command Center is audited
-- (who stored, activated, deactivated or verified which provider in which environment — never a
-- field value). Its own migration: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLATFORM_CREDENTIAL_STORED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLATFORM_CREDENTIAL_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLATFORM_CREDENTIAL_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLATFORM_CREDENTIAL_VERIFIED';
