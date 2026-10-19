-- ===========================================================================
-- Task T-A12 — donor-project actions on the ONE identity audit log. Values only.
-- ===========================================================================
ALTER TYPE "AuditAction" ADD VALUE 'DONOR_PROJECT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'DONOR_MEMBER_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'DONOR_MEMBER_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'DONOR_CONSENT_GIVEN';
ALTER TYPE "AuditAction" ADD VALUE 'DONOR_CONSENT_WITHDRAWN';
ALTER TYPE "AuditAction" ADD VALUE 'DONOR_PROJECT_CLOSED';
