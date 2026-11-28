-- M4.5 W4: an export of a report is recorded in the identity audit log (who exported which
-- report, in which format, under which filters, how many rows — never the data). Its own
-- migration because a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REPORT_EXPORTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REPORT_EXPORT_DOWNLOADED';
