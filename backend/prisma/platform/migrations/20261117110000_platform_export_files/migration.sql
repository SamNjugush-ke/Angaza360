-- ===========================================================================
-- PLATFORM REPORT EXPORT FILES (M4.5 Wave 4). HAND-WRITTEN.
--
-- A report export too large to stream is built in the background and kept here until it is
-- downloaded or expires. Platform reports only (the registry, applications, users, the audit log…) — a business's
-- own exports live in its own schema (tenant migration 0036).
-- The file is ENCRYPTED AT REST (AES-256-GCM through the credential cipher, keyRef app-v1) with a
-- sha256 of the plaintext; it is downloadable ONLY by the user who asked for it, ONLY until
-- `expiresAt`, and the cleanup job removes the ciphertext afterwards (EXPIRED). The row stays as
-- the record of the export; it is never deleted.
--
--   PENDING -> READY | FAILED ;  READY -> EXPIRED ;  FAILED and EXPIRED are final.
-- ===========================================================================

CREATE TABLE "platform_export_files" (
  "id"           TEXT NOT NULL,
  "reportId"     TEXT NOT NULL,
  "format"       TEXT NOT NULL,
  "filters"      JSONB NOT NULL,
  "rowCount"     INTEGER NOT NULL,
  "requestedBy"  TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'PENDING',
  "filename"     TEXT,
  "contentType"  TEXT,
  "byteSize"     INTEGER,
  "sha256"       TEXT,
  "ciphertext"   TEXT,
  "iv"           TEXT,
  "authTag"      TEXT,
  "keyRef"       TEXT,
  "error"        TEXT,
  "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"   TIMESTAMPTZ(3),
  "expiresAt"    TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "platform_export_files_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_export_files_format_known" CHECK ("format" IN ('xlsx', 'csv', 'pdf')),
  CONSTRAINT "platform_export_files_row_count_sane" CHECK ("rowCount" >= 0),
  -- The resting state of each status, failing closed for any other.
  CONSTRAINT "platform_export_files_status_coherent" CHECK (
    CASE "status"
      WHEN 'PENDING' THEN "ciphertext" IS NULL AND "finishedAt" IS NULL AND "error" IS NULL
      WHEN 'READY' THEN "ciphertext" IS NOT NULL AND "iv" IS NOT NULL AND "authTag" IS NOT NULL AND "keyRef" IS NOT NULL
                        AND "sha256" ~ '^[0-9a-f]{64}$' AND "filename" IS NOT NULL AND "contentType" IS NOT NULL
                        AND "byteSize" > 0 AND "finishedAt" IS NOT NULL AND "error" IS NULL
      WHEN 'FAILED' THEN "ciphertext" IS NULL AND "error" IS NOT NULL AND btrim("error") <> '' AND "finishedAt" IS NOT NULL
      WHEN 'EXPIRED' THEN "ciphertext" IS NULL AND "iv" IS NULL AND "authTag" IS NULL AND "finishedAt" IS NOT NULL
      ELSE false
    END
  )
);
CREATE INDEX "platform_export_files_requestedBy_idx" ON "platform_export_files"("requestedBy", "createdAt");
CREATE INDEX "platform_export_files_status_expiresAt_idx" ON "platform_export_files"("status", "expiresAt");

CREATE OR REPLACE FUNCTION platform_export_files_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform_export_files_guard: an export record is never deleted (%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'platform_export_files_guard: an export is born PENDING (got %)', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."reportId" IS DISTINCT FROM OLD."reportId" OR NEW."format" IS DISTINCT FROM OLD."format"
     OR NEW."filters" IS DISTINCT FROM OLD."filters" OR NEW."requestedBy" IS DISTINCT FROM OLD."requestedBy"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."rowCount" IS DISTINCT FROM OLD."rowCount" THEN
    RAISE EXCEPTION 'platform_export_files_guard: what was exported, for whom and when can never change (%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = OLD."status" THEN
    IF NEW."status" = 'PENDING' THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'platform_export_files_guard: export % is %, which is final', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD."status" = 'PENDING' AND NEW."status" IN ('READY', 'FAILED')) OR (OLD."status" = 'READY' AND NEW."status" = 'EXPIRED')) THEN
    RAISE EXCEPTION 'platform_export_files_guard: an export may not move % -> %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'READY' AND (NEW."filename" IS DISTINCT FROM OLD."filename" OR NEW."sha256" IS DISTINCT FROM OLD."sha256" OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt") THEN
    RAISE EXCEPTION 'platform_export_files_guard: an expired export keeps the record of what it was' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_export_files_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "platform_export_files"
  FOR EACH ROW EXECUTE FUNCTION platform_export_files_guard();
