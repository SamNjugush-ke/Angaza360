-- ===========================================================================
-- Task T-A4 — password reset tokens (platform schema).
--
-- Only the sha256 hex of a token is stored (like sessions."refreshTokenHash"); the raw
-- token leaves the server once, in the notification to its owner. A token is
-- SINGLE-USE: usedAt is stamped once and never again, and what the token IS (owner,
-- hash, expiry) never changes. Deletion is allowed — it is how a user's removal
-- cascades — and is not a way to un-use a token, because a deleted token is gone.
-- ===========================================================================

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A sha256 hex digest, never a raw token: 64 lowercase hex characters.
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_token_hash_is_sha256"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_token_expires_after_creation"
  CHECK ("expiresAt" > "createdAt");

CREATE OR REPLACE FUNCTION public.password_reset_token_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."usedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A password reset token cannot be created already used.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Password reset token %: its owner, hash and expiry can never change.', OLD."id";
  END IF;

  IF OLD."usedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Password reset token % has already been used; a token is single-use.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER password_reset_token_guard_iu
  BEFORE INSERT OR UPDATE ON public."password_reset_tokens"
  FOR EACH ROW EXECUTE FUNCTION public.password_reset_token_guard();
