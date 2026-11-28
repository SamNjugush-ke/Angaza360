-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('OPEN', 'ON_TRACK', 'AT_RISK', 'MET', 'MISSED');

-- CreateEnum
CREATE TYPE "IndicatorSourceKey" AS ENUM ('MONTHLY_REVENUE', 'NET_PROFIT', 'CASH_POSITION', 'RECEIVABLES_OUTSTANDING', 'GROSS_MARGIN_PCT', 'SALES_GROWTH_PCT', 'INVENTORY_TURNOVER');

-- CreateEnum
CREATE TYPE "ActionParty" AS ENUM ('MENTOR', 'ENTREPRENEUR');

-- CreateEnum
CREATE TYPE "ActionItemStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "mentorship_goals" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "targetValue" BIGINT,
    "targetMetric" TEXT,
    "targetDate" DATE,
    "status" "GoalStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mentorship_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentorship_indicators" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceKey" "IndicatorSourceKey" NOT NULL,
    "targetAmount" BIGINT,
    "targetRate" DECIMAL(9,2),
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentorship_indicators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentorship_action_items" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "responsibleParty" "ActionParty" NOT NULL,
    "dueDate" DATE,
    "status" "ActionItemStatus" NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMPTZ(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mentorship_action_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentorship_sessions" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "sessionDate" DATE NOT NULL,
    "summary" TEXT NOT NULL,
    "observations" TEXT,
    "commitments" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentorship_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mentorship_goals_engagementId_idx" ON "mentorship_goals"("engagementId");

-- CreateIndex
CREATE INDEX "mentorship_indicators_engagementId_idx" ON "mentorship_indicators"("engagementId");

-- CreateIndex
CREATE INDEX "mentorship_action_items_engagementId_idx" ON "mentorship_action_items"("engagementId");

-- CreateIndex
CREATE INDEX "mentorship_sessions_engagementId_sessionDate_idx" ON "mentorship_sessions"("engagementId", "sessionDate");

-- AddForeignKey
ALTER TABLE "mentorship_goals" ADD CONSTRAINT "mentorship_goals_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "mentorship_engagements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_goals" ADD CONSTRAINT "mentorship_goals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_indicators" ADD CONSTRAINT "mentorship_indicators_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "mentorship_engagements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_indicators" ADD CONSTRAINT "mentorship_indicators_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_action_items" ADD CONSTRAINT "mentorship_action_items_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "mentorship_engagements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_action_items" ADD CONSTRAINT "mentorship_action_items_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_sessions" ADD CONSTRAINT "mentorship_sessions_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "mentorship_engagements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_sessions" ADD CONSTRAINT "mentorship_sessions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- HAND-WRITTEN GUARDS (Task 14.2). The service (src/services/mentorship/coaching.ts)
-- returns the clean errors; these are the guarantee.
-- ===========================================================================

-- Non-blank text where a record would otherwise be meaningless.
ALTER TABLE "mentorship_goals"
  ADD CONSTRAINT "mentorship_goal_title_present" CHECK (length(btrim("title")) > 0);
ALTER TABLE "mentorship_indicators"
  ADD CONSTRAINT "mentorship_indicator_name_present" CHECK (length(btrim("name")) > 0);
ALTER TABLE "mentorship_action_items"
  ADD CONSTRAINT "mentorship_action_item_title_present" CHECK (length(btrim("title")) > 0);
ALTER TABLE "mentorship_sessions"
  ADD CONSTRAINT "mentorship_session_summary_present" CHECK (length(btrim("summary")) > 0);

-- AN INDICATOR'S TARGET IS EXACTLY ONE KIND, AND THE RIGHT ONE FOR ITS SOURCE.
-- Money KPIs carry targetAmount (cents) and no rate; ratio/percent KPIs carry
-- targetRate and no amount. Only NET_PROFIT and SALES_GROWTH_PCT may target a
-- negative figure (a smaller loss; a managed contraction).
ALTER TABLE "mentorship_indicators"
  ADD CONSTRAINT "mentorship_indicator_target_kind" CHECK (
    CASE
      WHEN "sourceKey" IN ('MONTHLY_REVENUE', 'NET_PROFIT', 'CASH_POSITION', 'RECEIVABLES_OUTSTANDING')
        THEN "targetAmount" IS NOT NULL AND "targetRate" IS NULL
             AND ("sourceKey" = 'NET_PROFIT' OR "targetAmount" >= 0)
      WHEN "sourceKey" IN ('GROSS_MARGIN_PCT', 'SALES_GROWTH_PCT', 'INVENTORY_TURNOVER')
        THEN "targetRate" IS NOT NULL AND "targetAmount" IS NULL
             AND ("sourceKey" = 'SALES_GROWTH_PCT' OR "targetRate" >= 0)
      ELSE false
    END
  );

-- DONE IFF completedAt: a completed action records when; nothing else may claim it.
ALTER TABLE "mentorship_action_items"
  ADD CONSTRAINT "mentorship_action_item_completion_coherent" CHECK (
    ("status" = 'DONE') = ("completedAt" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- ONE GUARD FOR ALL FOUR MENTORING TABLES, resolving its subject from TG_TABLE_NAME.
--
--   * No DELETE, ever: these are the record of a mentoring relationship.
--   * Every INSERT and UPDATE requires the engagement to be ACTIVE. On an ENDED (or
--     still-INVITED) engagement the records are READ-ONLY history.
--   * On INSERT the author must be the engagement's own mentor.
--   * id, engagementId, createdById and createdAt never change.
--   * Indicators and sessions are immutable once written (a changed target is a new
--     indicator; a correction is a new session).
--   * Goals are born OPEN; MET and MISSED are terminal.
--   * Action items are born OPEN; DONE and CANCELLED are terminal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mentorship_record_guard() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_mentor text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Mentoring record % in % cannot be deleted: it is part of the history of a mentoring relationship.',
      OLD."id", TG_TABLE_NAME;
  END IF;

  SELECT "status"::text, "mentorId" INTO v_status, v_mentor
    FROM public."mentorship_engagements" WHERE "id" = NEW."engagementId";
  IF v_status IS NULL OR v_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Mentoring records in % may only be written under an ACTIVE engagement (engagement % is %): an ended engagement''s records are read-only history.',
      TG_TABLE_NAME, NEW."engagementId", COALESCE(v_status, 'missing');
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."createdById" <> v_mentor THEN
      RAISE EXCEPTION 'Mentoring records in % may only be written by the engagement''s own mentor.', TG_TABLE_NAME;
    END IF;
    IF TG_TABLE_NAME = 'mentorship_goals' AND NEW."status"::text <> 'OPEN' THEN
      RAISE EXCEPTION 'A goal must be created OPEN (got %).', NEW."status";
    END IF;
    IF TG_TABLE_NAME = 'mentorship_action_items' AND NEW."status"::text <> 'OPEN' THEN
      RAISE EXCEPTION 'An action item must be created OPEN (got %).', NEW."status";
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF TG_TABLE_NAME IN ('mentorship_indicators', 'mentorship_sessions') THEN
    RAISE EXCEPTION 'Mentoring record % in % is immutable once written; record a new one instead.', OLD."id", TG_TABLE_NAME;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."engagementId" <> OLD."engagementId"
     OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'The identity, engagement, author and creation time of mentoring record % cannot change.', OLD."id";
  END IF;
  IF TG_TABLE_NAME = 'mentorship_goals' AND OLD."status"::text IN ('MET', 'MISSED') THEN
    RAISE EXCEPTION 'Goal % is % and terminal; it cannot be changed.', OLD."id", OLD."status";
  END IF;
  IF TG_TABLE_NAME = 'mentorship_action_items' AND OLD."status"::text IN ('DONE', 'CANCELLED') THEN
    RAISE EXCEPTION 'Action item % is % and terminal; it cannot be changed.', OLD."id", OLD."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mentorship_goal_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."mentorship_goals"
  FOR EACH ROW EXECUTE FUNCTION public.mentorship_record_guard();
CREATE TRIGGER mentorship_indicator_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."mentorship_indicators"
  FOR EACH ROW EXECUTE FUNCTION public.mentorship_record_guard();
CREATE TRIGGER mentorship_action_item_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."mentorship_action_items"
  FOR EACH ROW EXECUTE FUNCTION public.mentorship_record_guard();
CREATE TRIGGER mentorship_session_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."mentorship_sessions"
  FOR EACH ROW EXECUTE FUNCTION public.mentorship_record_guard();
