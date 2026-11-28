-- ===========================================================================
-- M4.5 Wave 2 — the comprehensive application, owner KYC documents, the review state machine
-- and the applicant's status access (platform schema; no tenant schema is touched).
--
-- (a) tenant_applications gains the business's structure, registration and contact details,
--     the county (admin analytics), the reviewer, the changes requested, and formVersion:
--     1 = every row before this migration (and admin/batch rows), 2 = the comprehensive
--     self-serve form, whose required fields and ID documents the database insists on.
-- (b) THE STATE MACHINE, held by the database:
--       DRAFT -> SUBMITTED (self-serve)                      SUBMITTED -> UNDER_REVIEW
--       UNDER_REVIEW -> NEEDS_CHANGES | APPROVED | REJECTED  NEEDS_CHANGES -> SUBMITTED
--       SUBMITTED -> APPROVED for a BATCH row only (its batch commit IS its review)
--     APPROVED and REJECTED are terminal. No skipping. While a self-serve application is
--     SUBMITTED or UNDER_REVIEW its SUBSTANTIVE fields (identity and ownership) are frozen:
--     a reviewer corrects administrative details only; anything else goes back to the
--     applicant (NEEDS_CHANGES) to change and re-confirm.
-- (c) application_documents: the owner's ID document, front and back — ENCRYPTED with the
--     credential cipher (AES-256-GCM; ciphertext + iv + authTag + keyRef), in this table and
--     nowhere else (never on disk, never under a served path). Added or replaced only while
--     the applicant may edit (DRAFT, NEEDS_CHANGES); after that the only change is the
--     retention PURGE, which removes the ciphertext and keeps a stub recording the purge.
-- (d) application_access_tokens: the applicant's status/edit secret, stored as sha256 only;
--     each notification mints a fresh one.
-- (e) application_document_views: single-use, short-lived, per-user view grants (sha256).
-- (f) tenant_application_events: the application's own append-only timeline, shown to the
--     applicant — what was asked, what a reviewer corrected, what was decided.
-- ===========================================================================

-- (a) -----------------------------------------------------------------------------
ALTER TABLE "tenant_applications"
  ADD COLUMN "formVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "businessStructure" TEXT,
  ADD COLUMN "registrationNumber" TEXT,
  ADD COLUMN "businessKraPin" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "physicalAddress" TEXT,
  ADD COLUMN "county" TEXT,
  ADD COLUMN "permitNumber" TEXT,
  ADD COLUMN "businessPhone" TEXT,
  ADD COLUMN "businessEmail" TEXT,
  ADD COLUMN "reviewerUserId" TEXT,
  ADD COLUMN "reviewStartedAt" TIMESTAMPTZ(3),
  ADD COLUMN "changesRequested" TEXT,
  ADD COLUMN "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "tenant_applications_county_idx" ON "tenant_applications"("county");

ALTER TABLE "tenant_applications" ADD CONSTRAINT "tenant_application_form_version_known"
  CHECK ("formVersion" IN (1, 2));
ALTER TABLE "tenant_applications" ADD CONSTRAINT "tenant_application_structure_known"
  CHECK ("businessStructure" IS NULL OR "businessStructure" IN ('SOLE_PROPRIETOR', 'PARTNERSHIP', 'LIMITED_COMPANY'));
-- The comprehensive form, once past DRAFT, is complete: structure, address, county and the
-- owner's National ID; a partnership or company carries its own KRA PIN, a company its
-- registration number.
ALTER TABLE "tenant_applications" ADD CONSTRAINT "tenant_application_v2_complete" CHECK (
  "formVersion" = 1 OR "status"::text = 'DRAFT' OR (
    "businessStructure" IS NOT NULL
    AND btrim(COALESCE("physicalAddress", '')) <> ''
    AND btrim(COALESCE("county", '')) <> ''
    AND "ownerNationalId" IS NOT NULL
    AND ("businessStructure" = 'SOLE_PROPRIETOR' OR "businessKraPin" IS NOT NULL)
    AND ("businessStructure" <> 'LIMITED_COMPANY' OR btrim(COALESCE("registrationNumber", '')) <> '')
  )
);

-- (b) -----------------------------------------------------------------------------
-- Replace T-A6.2's resting-state CHECK: it named PENDING_APPROVAL (now SUBMITTED) and ended
-- ELSE false, so it must list every status. Fail closed, as before.
ALTER TABLE "tenant_applications" DROP CONSTRAINT "tenant_application_decision_coherent";
ALTER TABLE "tenant_applications" ADD CONSTRAINT "tenant_application_decision_coherent" CHECK (
  CASE "status"::text
    WHEN 'DRAFT' THEN "reviewedAt" IS NULL AND "resultingTenantId" IS NULL AND "rejectionReason" IS NULL AND "reviewerUserId" IS NULL
    WHEN 'SUBMITTED' THEN "reviewedAt" IS NULL AND "resultingTenantId" IS NULL AND "rejectionReason" IS NULL
    WHEN 'UNDER_REVIEW' THEN "reviewedAt" IS NULL AND "resultingTenantId" IS NULL AND "rejectionReason" IS NULL AND "reviewerUserId" IS NOT NULL AND "reviewStartedAt" IS NOT NULL
    WHEN 'NEEDS_CHANGES' THEN "reviewedAt" IS NULL AND "resultingTenantId" IS NULL AND "rejectionReason" IS NULL AND btrim(COALESCE("changesRequested", '')) <> ''
    WHEN 'APPROVED' THEN "reviewedAt" IS NOT NULL AND "resultingTenantId" IS NOT NULL AND "rejectionReason" IS NULL
    WHEN 'REJECTED' THEN "reviewedAt" IS NOT NULL AND "resultingTenantId" IS NULL AND btrim(COALESCE("rejectionReason", '')) <> ''
    ELSE false
  END
);

CREATE OR REPLACE FUNCTION public.tenant_application_guard() RETURNS trigger AS $$
DECLARE
  v_from text;
  v_to text;
  v_docs int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."source"::text = 'SELF_SERVE' AND NEW."status"::text <> 'DRAFT' THEN
      RAISE EXCEPTION 'A self-serve application is created as a DRAFT (got %).', NEW."status";
    END IF;
    IF NEW."source"::text <> 'SELF_SERVE' AND NEW."status"::text <> 'SUBMITTED' THEN
      RAISE EXCEPTION 'An admin or batch application is created SUBMITTED (got %).', NEW."status";
    END IF;
    RETURN NEW;
  END IF;

  v_from := OLD."status"::text;

  IF TG_OP = 'DELETE' THEN
    IF v_from = 'DRAFT' OR (v_from = 'SUBMITTED' AND OLD."source"::text = 'BATCH') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Tenant application % is %: only a draft or a batch preview row can be removed — a submitted application is a permanent record.', OLD."id", v_from;
  END IF;

  v_to := NEW."status"::text;
  IF v_from IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'Tenant application % is %, which is final.', OLD."id", v_from;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."batchId" IS DISTINCT FROM OLD."batchId"
     OR NEW."formVersion" IS DISTINCT FROM OLD."formVersion"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Tenant application %: its source, batch, form version and creation time never change.', OLD."id";
  END IF;

  IF v_to IS DISTINCT FROM v_from THEN
    IF NOT (
         (v_from = 'DRAFT' AND v_to = 'SUBMITTED')
      OR (v_from = 'SUBMITTED' AND v_to = 'UNDER_REVIEW')
      OR (v_from = 'SUBMITTED' AND v_to = 'APPROVED' AND OLD."source"::text = 'BATCH')
      OR (v_from = 'UNDER_REVIEW' AND v_to IN ('NEEDS_CHANGES', 'APPROVED', 'REJECTED'))
      OR (v_from = 'NEEDS_CHANGES' AND v_to = 'SUBMITTED')
    ) THEN
      RAISE EXCEPTION 'Tenant application % may not move % -> % (no step is skipped).', OLD."id", v_from, v_to;
    END IF;
    -- A (re)submission of the comprehensive form carries both sides of the owner's ID.
    IF v_to = 'SUBMITTED' AND NEW."formVersion" = 2 THEN
      SELECT count(DISTINCT "side") INTO v_docs FROM public."application_documents"
       WHERE "applicationId" = NEW."id" AND "purgedAt" IS NULL;
      IF v_docs < 2 THEN
        RAISE EXCEPTION 'Tenant application % cannot be submitted without the owner''s ID document, front and back.', OLD."id";
      END IF;
    END IF;
  ELSIF NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
    RAISE EXCEPTION 'Tenant application %: the submission time is set only when it is (re)submitted.', OLD."id";
  END IF;

  -- IDENTITY AND OWNERSHIP ARE NEVER CHANGED BEHIND THE APPLICANT. Once a self-serve
  -- application is submitted, and throughout its review, only administrative details move.
  IF (v_from = 'UNDER_REVIEW' OR (v_from = 'SUBMITTED' AND OLD."source"::text <> 'BATCH'))
     AND (NEW."businessName" IS DISTINCT FROM OLD."businessName"
       OR NEW."businessStructure" IS DISTINCT FROM OLD."businessStructure"
       OR NEW."registrationNumber" IS DISTINCT FROM OLD."registrationNumber"
       OR NEW."kraPin" IS DISTINCT FROM OLD."kraPin"
       OR NEW."businessKraPin" IS DISTINCT FROM OLD."businessKraPin"
       OR NEW."taxRegime" IS DISTINCT FROM OLD."taxRegime"
       OR NEW."ownerFullName" IS DISTINCT FROM OLD."ownerFullName"
       OR NEW."ownerEmail" IS DISTINCT FROM OLD."ownerEmail"
       OR NEW."ownerPhone" IS DISTINCT FROM OLD."ownerPhone"
       OR NEW."ownerNationalId" IS DISTINCT FROM OLD."ownerNationalId") THEN
    RAISE EXCEPTION 'Tenant application %: its identity and ownership details cannot be changed during review — request changes from the applicant instead.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- (c) -----------------------------------------------------------------------------
CREATE TABLE "application_documents" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "ciphertext" TEXT,
    "iv" TEXT,
    "authTag" TEXT,
    "keyRef" TEXT,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgedAt" TIMESTAMPTZ(3),

    CONSTRAINT "application_documents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "application_documents_applicationId_idx" ON "application_documents"("applicationId");
CREATE UNIQUE INDEX "application_documents_one_live_side" ON "application_documents"("applicationId", "side") WHERE "purgedAt" IS NULL;
ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "tenant_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "application_documents" ADD CONSTRAINT "application_document_kind_known" CHECK ("kind" = 'NATIONAL_ID');
ALTER TABLE "application_documents" ADD CONSTRAINT "application_document_side_known" CHECK ("side" IN ('FRONT', 'BACK'));
ALTER TABLE "application_documents" ADD CONSTRAINT "application_document_type_allowed"
  CHECK ("contentType" IN ('image/jpeg', 'image/png', 'application/pdf'));
ALTER TABLE "application_documents" ADD CONSTRAINT "application_document_size_bounded" CHECK ("byteSize" BETWEEN 1 AND 5242880);
ALTER TABLE "application_documents" ADD CONSTRAINT "application_document_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
-- Either live (the whole encrypted blob) or purged (none of it, and when).
ALTER TABLE "application_documents" ADD CONSTRAINT "application_document_live_or_purged" CHECK (
  ("purgedAt" IS NULL AND "ciphertext" IS NOT NULL AND "iv" IS NOT NULL AND "authTag" IS NOT NULL AND "keyRef" IS NOT NULL)
  OR ("purgedAt" IS NOT NULL AND "ciphertext" IS NULL AND "iv" IS NULL AND "authTag" IS NULL AND "keyRef" IS NULL)
);

CREATE OR REPLACE FUNCTION public.application_document_guard() RETURNS trigger AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM public."tenant_applications"
   WHERE "id" = COALESCE(NEW."applicationId", OLD."applicationId");
  IF TG_OP = 'INSERT' THEN
    IF NEW."purgedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'An application document cannot be stored already purged.';
    END IF;
    IF v_status NOT IN ('DRAFT', 'NEEDS_CHANGES') THEN
      RAISE EXCEPTION 'An ID document can be added only while the applicant may edit the application (it is %).', v_status;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- A replacement while editing, or the application's own removal (a draft) — nothing else.
    IF v_status IS NULL OR v_status IN ('DRAFT', 'NEEDS_CHANGES') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'An ID document of a % application is kept until the retention purge.', v_status;
  END IF;
  -- UPDATE: only the retention purge, once.
  IF OLD."purgedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Application document % has been purged; nothing about it changes.', OLD."id";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."applicationId" IS DISTINCT FROM OLD."applicationId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."side" IS DISTINCT FROM OLD."side"
     OR NEW."contentType" IS DISTINCT FROM OLD."contentType" OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize"
     OR NEW."sha256" IS DISTINCT FROM OLD."sha256" OR NEW."uploadedAt" IS DISTINCT FROM OLD."uploadedAt"
     OR NEW."purgedAt" IS NULL THEN
    RAISE EXCEPTION 'Application document %: the only permitted change is the retention purge.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_document_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."application_documents"
  FOR EACH ROW EXECUTE FUNCTION public.application_document_guard();

-- (d) -----------------------------------------------------------------------------
CREATE TABLE "application_access_tokens" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "application_access_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "application_access_tokens_tokenHash_key" ON "application_access_tokens"("tokenHash");
CREATE INDEX "application_access_tokens_applicationId_idx" ON "application_access_tokens"("applicationId");
ALTER TABLE "application_access_tokens" ADD CONSTRAINT "application_access_tokens_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "tenant_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "application_access_tokens" ADD CONSTRAINT "application_access_token_sha256" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "application_access_tokens" ADD CONSTRAINT "application_access_token_expires_after_creation" CHECK ("expiresAt" > "createdAt");

-- (e) -----------------------------------------------------------------------------
CREATE TABLE "application_document_views" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),

    CONSTRAINT "application_document_views_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "application_document_views_tokenHash_key" ON "application_document_views"("tokenHash");
ALTER TABLE "application_document_views" ADD CONSTRAINT "application_document_views_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "application_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "application_document_views" ADD CONSTRAINT "application_document_view_sha256" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "application_document_views" ADD CONSTRAINT "application_document_view_short_lived"
  CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '5 minutes');

CREATE OR REPLACE FUNCTION public.application_document_view_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."usedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A document view grant cannot be created already used.';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."usedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Document view grant % has been used; a grant is single-use.', OLD."id";
  END IF;
  IF NEW."documentId" IS DISTINCT FROM OLD."documentId" OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Document view grant %: who it is for, what it opens and when it expires never change.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_document_view_guard_iu
  BEFORE INSERT OR UPDATE ON public."application_document_views"
  FOR EACH ROW EXECUTE FUNCTION public.application_document_view_guard();

-- (f) -----------------------------------------------------------------------------
CREATE TABLE "tenant_application_events" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "message" TEXT,
    "details" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_application_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tenant_application_events_applicationId_occurredAt_idx" ON "tenant_application_events"("applicationId", "occurredAt");
ALTER TABLE "tenant_application_events" ADD CONSTRAINT "tenant_application_events_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "tenant_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_application_events" ADD CONSTRAINT "tenant_application_event_kind_known" CHECK ("kind" IN (
  'SUBMITTED', 'REVIEW_STARTED', 'CHANGES_REQUESTED', 'CORRECTED', 'RESUBMITTED', 'APPROVED', 'REJECTED', 'DOCUMENTS_PURGED'
));

-- Append-only, except the cascade when a DRAFT application (which has no events) or a batch
-- preview row is removed.
CREATE OR REPLACE FUNCTION public.tenant_application_event_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public."tenant_applications" WHERE "id" = OLD."applicationId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'The application timeline is append-only: % is refused.', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_application_event_guard_ud
  BEFORE UPDATE OR DELETE ON public."tenant_application_events"
  FOR EACH ROW EXECUTE FUNCTION public.tenant_application_event_guard();

-- The registry learns the county and structure at provisioning (admin analytics).
ALTER TABLE "tenants"
  ADD COLUMN "county" TEXT,
  ADD COLUMN "businessStructure" TEXT;
CREATE INDEX "tenants_county_idx" ON "tenants"("county");
