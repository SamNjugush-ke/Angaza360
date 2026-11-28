-- ===========================================================================
-- M4.5 Wave 1 — native TOTP MFA, forced reset on first login, and the login
-- challenge (platform schema). No tenant schema is touched.
--
-- (a) users: the TOTP secret is stored ENCRYPTED — AES-256-GCM through the same
--     cipher as the integration credentials (ciphertext + iv + authTag + keyRef) —
--     and never in plaintext. mfaLastUsedStep is the replay guard: a TOTP step,
--     once accepted, can never be accepted again. mustResetPassword forces a new
--     password before any session is issued.
-- (b) mfa_backup_codes: one-time recovery codes, stored ONLY as sha256 hex; a used
--     code is burned for good.
-- (c) login_challenges: a login that still owes a step (an MFA code, a forced new
--     password, an MFA enrolment) gets a short-lived, single-use challenge instead
--     of a session; its stages can only be cleared, never re-opened.
-- (d) sessions: mfaVerifiedAt (the session was opened by proving a second factor)
--     and stepUpAt (a fresh TOTP was proven for a sensitive action). The DATABASE
--     refuses a SUPER_ADMIN or PROGRAM_OFFICER session without mfaVerifiedAt.
-- ===========================================================================

-- (a) ---------------------------------------------------------------------------
ALTER TABLE "users"
  ADD COLUMN "mustResetPassword" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mfaSecretCiphertext" TEXT,
  ADD COLUMN "mfaSecretIv" TEXT,
  ADD COLUMN "mfaSecretAuthTag" TEXT,
  ADD COLUMN "mfaSecretKeyRef" TEXT,
  ADD COLUMN "mfaEnrolledAt" TIMESTAMPTZ(3),
  ADD COLUMN "mfaLastUsedStep" BIGINT;

-- The four parts of the encrypted secret exist together or not at all.
ALTER TABLE "users" ADD CONSTRAINT "user_mfa_secret_complete" CHECK (
  ("mfaSecretCiphertext" IS NULL AND "mfaSecretIv" IS NULL AND "mfaSecretAuthTag" IS NULL AND "mfaSecretKeyRef" IS NULL)
  OR ("mfaSecretCiphertext" IS NOT NULL AND "mfaSecretIv" IS NOT NULL AND "mfaSecretAuthTag" IS NOT NULL AND "mfaSecretKeyRef" IS NOT NULL)
);

-- MFA is ON only with an (encrypted) secret and an enrolment time behind it.
ALTER TABLE "users" ADD CONSTRAINT "user_mfa_enabled_has_secret" CHECK (
  NOT "mfaEnabled" OR ("mfaSecretCiphertext" IS NOT NULL AND "mfaEnrolledAt" IS NOT NULL)
);

-- The replay guard only moves forward while the secret is the same: a TOTP step that
-- was accepted can never be accepted again. A NEW secret (re-enrolment) or a cleared
-- one (an MFA reset) starts afresh.
CREATE OR REPLACE FUNCTION public.user_mfa_step_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."mfaLastUsedStep" IS NOT NULL
     AND NEW."mfaSecretCiphertext" IS NOT DISTINCT FROM OLD."mfaSecretCiphertext"
     AND (NEW."mfaLastUsedStep" IS NULL OR NEW."mfaLastUsedStep" < OLD."mfaLastUsedStep") THEN
    RAISE EXCEPTION 'User %: the last accepted MFA step can only move forward (a used TOTP code can never be accepted again).', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_mfa_step_guard_u
  BEFORE UPDATE ON public."users"
  FOR EACH ROW EXECUTE FUNCTION public.user_mfa_step_guard();

-- (b) ---------------------------------------------------------------------------
CREATE TABLE "mfa_backup_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_backup_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mfa_backup_codes_userId_codeHash_key" ON "mfa_backup_codes"("userId", "codeHash");
CREATE INDEX "mfa_backup_codes_userId_idx" ON "mfa_backup_codes"("userId");

ALTER TABLE "mfa_backup_codes" ADD CONSTRAINT "mfa_backup_codes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mfa_backup_codes" ADD CONSTRAINT "mfa_backup_code_hash_is_sha256"
  CHECK ("codeHash" ~ '^[0-9a-f]{64}$');

-- A backup code is born unused, its owner and hash never change, and once used it is
-- burned: usedAt is set once and the row is then frozen. DELETE is allowed — it is how
-- a regeneration or an MFA reset retires a whole set — and it cannot un-use a code,
-- because a deleted code is gone.
CREATE OR REPLACE FUNCTION public.mfa_backup_code_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."usedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A backup code cannot be created already used.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."codeHash" IS DISTINCT FROM OLD."codeHash"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Backup code %: its owner and hash can never change.', OLD."id";
  END IF;
  IF OLD."usedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Backup code % has already been used; a backup code is single-use.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mfa_backup_code_guard_iu
  BEFORE INSERT OR UPDATE ON public."mfa_backup_codes"
  FOR EACH ROW EXECUTE FUNCTION public.mfa_backup_code_guard();

-- (c) ---------------------------------------------------------------------------
CREATE TABLE "login_challenges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "needsMfa" BOOLEAN NOT NULL,
    "needsPasswordReset" BOOLEAN NOT NULL,
    "needsMfaEnrollment" BOOLEAN NOT NULL,
    "mfaVerified" BOOLEAN NOT NULL DEFAULT false,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "ipAddress" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "login_challenges_tokenHash_key" ON "login_challenges"("tokenHash");
CREATE INDEX "login_challenges_userId_idx" ON "login_challenges"("userId");

ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenge_hash_is_sha256"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenge_expires_after_creation"
  CHECK ("expiresAt" > "createdAt");
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenge_attempts_non_negative"
  CHECK ("failedAttempts" >= 0);
-- A user either proves an existing factor or enrols one, never both in one login.
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenge_mfa_xor_enrolment"
  CHECK (NOT ("needsMfa" AND "needsMfaEnrollment"));

-- The challenge's stages can only be CLEARED (true -> false), never re-opened; an MFA
-- stage clears only with the factor proven; attempts only rise; and a consumed
-- challenge is frozen. What the challenge IS (owner, hash, expiry) never changes.
CREATE OR REPLACE FUNCTION public.login_challenge_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."consumedAt" IS NOT NULL OR NEW."failedAttempts" <> 0 OR NEW."mfaVerified" THEN
      RAISE EXCEPTION 'A login challenge must be created open: unconsumed, with no attempts and no factor proven.';
    END IF;
    IF NOT (NEW."needsMfa" OR NEW."needsPasswordReset" OR NEW."needsMfaEnrollment") THEN
      RAISE EXCEPTION 'A login challenge must owe at least one step.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."ipAddress" IS DISTINCT FROM OLD."ipAddress" THEN
    RAISE EXCEPTION 'Login challenge %: its owner, hash and expiry can never change.', OLD."id";
  END IF;
  IF OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Login challenge % has already been consumed; a challenge is single-use.', OLD."id";
  END IF;
  IF (NEW."needsMfa" AND NOT OLD."needsMfa")
     OR (NEW."needsPasswordReset" AND NOT OLD."needsPasswordReset")
     OR (NEW."needsMfaEnrollment" AND NOT OLD."needsMfaEnrollment")
     OR (OLD."mfaVerified" AND NOT NEW."mfaVerified") THEN
    RAISE EXCEPTION 'Login challenge %: a cleared step can never be re-opened.', OLD."id";
  END IF;
  IF ((OLD."needsMfa" AND NOT NEW."needsMfa") OR (OLD."needsMfaEnrollment" AND NOT NEW."needsMfaEnrollment"))
     AND NOT NEW."mfaVerified" THEN
    RAISE EXCEPTION 'Login challenge %: an MFA step clears only with the factor proven.', OLD."id";
  END IF;
  IF NEW."failedAttempts" < OLD."failedAttempts" THEN
    RAISE EXCEPTION 'Login challenge %: failed attempts can only rise.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER login_challenge_guard_iu
  BEFORE INSERT OR UPDATE ON public."login_challenges"
  FOR EACH ROW EXECUTE FUNCTION public.login_challenge_guard();

-- (d) ---------------------------------------------------------------------------
ALTER TABLE "sessions"
  ADD COLUMN "mfaVerifiedAt" TIMESTAMPTZ(3),
  ADD COLUMN "stepUpAt" TIMESTAMPTZ(3);

-- A step-up is a second proof on a session that was already MFA-verified.
ALTER TABLE "sessions" ADD CONSTRAINT "session_step_up_needs_mfa"
  CHECK ("stepUpAt" IS NULL OR "mfaVerifiedAt" IS NOT NULL);

-- NO ADMIN SESSION WITHOUT MFA: a SUPER_ADMIN or PROGRAM_OFFICER session must be born
-- MFA-verified, for every writer. And on any session, an MFA stamp, once set, cannot be
-- removed or rewritten.
CREATE OR REPLACE FUNCTION public.session_mfa_guard() RETURNS trigger AS $$
DECLARE
  v_role text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "role"::text INTO v_role FROM public."users" WHERE "id" = NEW."userId";
    IF v_role IN ('SUPER_ADMIN', 'PROGRAM_OFFICER') AND NEW."mfaVerifiedAt" IS NULL THEN
      RAISE EXCEPTION 'A % session must be MFA-verified: platform administrators cannot sign in without a second factor.', v_role;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."mfaVerifiedAt" IS NOT NULL AND NEW."mfaVerifiedAt" IS DISTINCT FROM OLD."mfaVerifiedAt" THEN
    RAISE EXCEPTION 'Session %: its MFA verification, once recorded, can never be removed or rewritten.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_mfa_guard_iu
  BEFORE INSERT OR UPDATE ON public."sessions"
  FOR EACH ROW EXECUTE FUNCTION public.session_mfa_guard();
