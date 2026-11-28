-- ===========================================================================
-- M4.5 Wave 2 — the application state machine's VALUES (and the audit actions it needs).
-- Values only; the rules that use them are the next migration (a value added here cannot be
-- used as a literal until this one commits).
--
-- PENDING_APPROVAL is RENAMED to SUBMITTED: every existing open application (and every batch
-- preview row) is, by definition, submitted and awaiting a decision. A rename rewrites no row.
-- APPROVED and REJECTED are kept as they are.
-- ===========================================================================
ALTER TYPE "TenantApplicationStatus" RENAME VALUE 'PENDING_APPROVAL' TO 'SUBMITTED';
ALTER TYPE "TenantApplicationStatus" ADD VALUE 'DRAFT' BEFORE 'SUBMITTED';
ALTER TYPE "TenantApplicationStatus" ADD VALUE 'UNDER_REVIEW' AFTER 'SUBMITTED';
ALTER TYPE "TenantApplicationStatus" ADD VALUE 'NEEDS_CHANGES' AFTER 'UNDER_REVIEW';

ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_REVIEW_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_CHANGES_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_CORRECTED';
ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_RESUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_DOCUMENT_VIEWED';
ALTER TYPE "AuditAction" ADD VALUE 'APPLICATION_DOCUMENTS_PURGED';
