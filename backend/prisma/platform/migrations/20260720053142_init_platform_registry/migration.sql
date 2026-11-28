-- CreateEnum
CREATE TYPE "TenantIsolationTier" AS ENUM ('SHARED_POOL', 'DEDICATED_SCHEMA', 'DEDICATED_INSTANCE');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('PENDING_PROVISIONING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('MWANZO', 'UKUAJI', 'BIASHARA', 'MSTAWI', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaxRegime" AS ENUM ('VAT', 'TURNOVER_TAX', 'EXEMPT');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'PROGRAM_OFFICER', 'MSME_OWNER', 'MSME_MANAGER', 'ACCOUNTANT', 'CASHIER', 'WAREHOUSE_STAFF', 'HR_OFFICER', 'VIEWER_AUDITOR');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessSector" TEXT,
    "kraPin" TEXT,
    "taxRegime" "TaxRegime" NOT NULL DEFAULT 'TURNOVER_TAX',
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "subdomain" TEXT NOT NULL,
    "customDomain" TEXT,
    "dbSchema" TEXT NOT NULL,
    "isolationTier" "TenantIsolationTier" NOT NULL DEFAULT 'SHARED_POOL',
    "status" "TenantStatus" NOT NULL DEFAULT 'PENDING_PROVISIONING',
    "subscriptionTier" "SubscriptionTier" NOT NULL DEFAULT 'MWANZO',
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "subscriptionRenewsAt" TIMESTAMP(3),
    "donorProjectCode" TEXT,
    "brandPrimaryColor" TEXT,
    "brandLogoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "authUid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "fullName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_subdomain_key" ON "tenants"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_customDomain_key" ON "tenants"("customDomain");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_dbSchema_key" ON "tenants"("dbSchema");

-- CreateIndex
CREATE UNIQUE INDEX "users_authUid_key" ON "users"("authUid");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_tenantId_idx" ON "users"("tenantId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
