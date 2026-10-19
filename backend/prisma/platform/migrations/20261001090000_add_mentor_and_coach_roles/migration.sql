-- ===========================================================================
-- RBAC READINESS — MENTOR and COACH (Task OFF.1).
--
-- Two new values on the platform UserRole enum, and nothing else. This is the
-- whole of the platform datamodel change in this task: additive, no table
-- touched, no row rewritten, no default changed.
--
-- WHY NOW, in an offline task: the mentorship module is post-MVP, but adding an
-- enum value to a live identity table is the kind of change that is cheap today
-- and awkward mid-feature. Adding them here means enabling mentorship later is
-- new routes and new rows rather than an ALTER TYPE against `public.users` while
-- sessions are being issued against it.
--
-- WHAT THEY CAN DO TODAY: nothing. They are VALID roles — a session for a user
-- holding one resolves through exactly the same gate as every other role
-- (src/plugins/auth.ts requireAuth/requireRole) — but no route lists MENTOR or
-- COACH in its requireRole(...) call, so every guarded route refuses them with
-- 403. That is the intended read-only placeholder posture: a role that exists,
-- authenticates, and is permitted nothing until the module that needs it arrives.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe on PostgreSQL 12+ as long as the
-- new value is not USED in the same transaction. Nothing below uses it.
-- ===========================================================================

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'MENTOR';

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'COACH';
