-- M4.5 W5 (standing god-mode): a SUPER_ADMIN acting as a tenant (act-as-tenant) records every
-- action with OPERATOR_ACTED — which operator, which business, what route, when. It lands in the
-- internal platform audit log AND, filtered to the business, in the owner-visible activity log
-- (attributed to the platform operator, never named). Its own migration: a new enum value cannot
-- be used in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OPERATOR_ACTED';
