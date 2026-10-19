-- ---------------------------------------------------------------------------
-- Migration 0002: money as BigInt cents, and the Chart of Accounts.
--
-- HAND-EDITED — DO NOT "FIX" THE products COLUMN CHANGES BACK.
-- Prisma's generated diff renders the Decimal -> BigInt change as a bare
-- `SET DATA TYPE BIGINT`, whose implicit numeric->bigint cast TRUNCATES the
-- major-unit value (250.00 -> 250) and silently DESTROYS the cents. Money is
-- stored in KES cents (minor units), so existing rows must be multiplied by
-- 100 as part of the type change. The USING clauses below do exactly that and
-- are intentionally written by hand; the accounts table and enum DDL are left
-- exactly as Prisma generated them.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "AccountClass" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COST_OF_SALES', 'EXPENSE');

-- CreateEnum
CREATE TYPE "NormalBalance" AS ENUM ('DEBIT', 'CREDIT');

-- AlterTable (hand-edited: preserve value by converting major units to cents)
ALTER TABLE "products" ALTER COLUMN "costPrice" TYPE BIGINT
  USING ROUND("costPrice" * 100)::BIGINT;
ALTER TABLE "products" ALTER COLUMN "price" TYPE BIGINT
  USING ROUND("price" * 100)::BIGINT;

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountClass" "AccountClass" NOT NULL,
    "normalBalance" "NormalBalance" NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

-- CreateIndex
CREATE INDEX "accounts_accountClass_idx" ON "accounts"("accountClass");
