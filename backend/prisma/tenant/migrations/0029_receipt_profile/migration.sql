-- ===========================================================================
-- 0029 — RECEIPT / DISPLAY IDENTITY ON THE BUSINESS PROFILE (Task T-A13). HAND-WRITTEN.
--
-- The fields a printed receipt needs, on the per-tenant singleton: the business's legal
-- name, an address line, a phone number, an email, a receipt footer, and whether to print
-- the logo. DISPLAY ONLY — nothing posts from them. Branding (primary colour, logo URL)
-- already lives on the platform registry row and is read alongside.
--
-- Every column is nullable or defaulted, so the existing singleton takes the defaults and
-- no row is rewritten beyond that.
-- ===========================================================================

ALTER TABLE "business_profile" ADD COLUMN "legalName" TEXT;
ALTER TABLE "business_profile" ADD COLUMN "addressLine" TEXT;
ALTER TABLE "business_profile" ADD COLUMN "phone" TEXT;
ALTER TABLE "business_profile" ADD COLUMN "email" TEXT;
ALTER TABLE "business_profile" ADD COLUMN "receiptFooter" TEXT;
ALTER TABLE "business_profile" ADD COLUMN "showLogoOnReceipt" BOOLEAN NOT NULL DEFAULT true;

-- A printed field is either absent or says something, and fits on a receipt.
ALTER TABLE "business_profile" ADD CONSTRAINT "business_profile_receipt_fields_sane" CHECK (
  ("legalName" IS NULL OR (btrim("legalName") <> '' AND length("legalName") <= 200))
  AND ("addressLine" IS NULL OR (btrim("addressLine") <> '' AND length("addressLine") <= 300))
  AND ("phone" IS NULL OR (btrim("phone") <> '' AND length("phone") <= 30))
  AND ("email" IS NULL OR (btrim("email") <> '' AND length("email") <= 320))
  AND ("receiptFooter" IS NULL OR (btrim("receiptFooter") <> '' AND length("receiptFooter") <= 500))
);
