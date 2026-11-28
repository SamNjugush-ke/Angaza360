-- Task H.1 — the platform registry's machine timestamps become TIMESTAMPTZ.
--
-- Hand-written rather than generated: Prisma's diff emits a bare `SET DATA TYPE
-- TIMESTAMPTZ(3)`, which interprets each naive value in the SESSION's zone
-- (Africa/Nairobi on this server's default) and would shift every session expiry and
-- audit time three hours. `AT TIME ZONE 'UTC'` declares what is true: Prisma wrote
-- them in UTC. The platform holds no business dates, so nothing here becomes DATE.
-- The tenant-schema counterpart is tenant migration 0023_timestamps_utc.

ALTER TABLE "platform_integration_credentials"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "sessions"
  ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "issuedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "issuedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "revokedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "revokedAt" AT TIME ZONE 'UTC';

ALTER TABLE "tenants"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "subscriptionRenewsAt" SET DATA TYPE TIMESTAMPTZ(3) USING "subscriptionRenewsAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "users"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "lastLoginAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastLoginAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "passwordUpdatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "passwordUpdatedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

