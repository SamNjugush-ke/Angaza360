-- ===========================================================================
-- Task 14.3 — the entrepreneur's ONE write: completing an action item assigned to them.
--
-- `completedById` records WHO marked an item DONE. The guard below is extended so the
-- database itself decides whether a completion by someone other than the mentor is
-- legitimate: only an ACTIVE MSME_OWNER of the engaged business, only on an item whose
-- responsibleParty is ENTREPRENEUR, only OPEN -> DONE, and changing nothing else.
-- A NULL completedById on a DONE item is a pre-14.3 completion, when only the mentor
-- could complete anything (NULL-means-default; no backfill).
-- ===========================================================================

-- AlterTable
ALTER TABLE "mentorship_action_items" ADD COLUMN     "completedById" TEXT;

-- AddForeignKey
ALTER TABLE "mentorship_action_items" ADD CONSTRAINT "mentorship_action_items_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A completer exists only on a DONE item.
ALTER TABLE "mentorship_action_items"
  ADD CONSTRAINT "mentorship_action_item_completer_only_when_done" CHECK (
    "completedById" IS NULL OR "status" = 'DONE'
  );

CREATE OR REPLACE FUNCTION public.mentorship_record_guard() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_mentor text;
  v_tenant text;
  v_role   text;
  v_utenant text;
  v_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Mentoring record % in % cannot be deleted: it is part of the history of a mentoring relationship.',
      OLD."id", TG_TABLE_NAME;
  END IF;

  SELECT "status"::text, "mentorId", "tenantId" INTO v_status, v_mentor, v_tenant
    FROM public."mentorship_engagements" WHERE "id" = NEW."engagementId";
  IF v_status IS NULL OR v_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Mentoring records in % may only be written under an ACTIVE engagement (engagement % is %): an ended engagement''s records are read-only history.',
      TG_TABLE_NAME, NEW."engagementId", COALESCE(v_status, 'missing');
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."createdById" <> v_mentor THEN
      RAISE EXCEPTION 'Mentoring records in % may only be written by the engagement''s own mentor.', TG_TABLE_NAME;
    END IF;
    IF TG_TABLE_NAME IN ('mentorship_goals', 'mentorship_action_items') THEN
      IF NEW."status"::text <> 'OPEN' THEN
        RAISE EXCEPTION 'A record in % must be created OPEN (got %).', TG_TABLE_NAME, NEW."status";
      END IF;
    END IF;
    IF TG_TABLE_NAME = 'mentorship_action_items' THEN
      IF NEW."completedById" IS NOT NULL THEN
        RAISE EXCEPTION 'An action item cannot be created already completed.';
      END IF;
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
  -- Only goals and action items reach here; both have a status column.
  IF TG_TABLE_NAME = 'mentorship_goals' THEN
    IF OLD."status"::text IN ('MET', 'MISSED') THEN
      RAISE EXCEPTION 'Goal % is % and terminal; it cannot be changed.', OLD."id", OLD."status";
    END IF;
  ELSE
    IF OLD."status"::text IN ('DONE', 'CANCELLED') THEN
      RAISE EXCEPTION 'Action item % is % and terminal; it cannot be changed.', OLD."id", OLD."status";
    END IF;
    -- A completion by anyone other than the mentor is the ENTREPRENEUR's write.
    IF NEW."completedById" IS NOT NULL AND NEW."completedById" <> v_mentor THEN
      SELECT "role"::text, "tenantId", "isActive" INTO v_role, v_utenant, v_active
        FROM public."users" WHERE "id" = NEW."completedById";
      IF v_role IS DISTINCT FROM 'MSME_OWNER' OR v_utenant IS DISTINCT FROM v_tenant OR NOT COALESCE(v_active, false) THEN
        RAISE EXCEPTION 'Action item % may be completed only by the mentor or an active owner of the engaged business.', OLD."id";
      END IF;
      IF OLD."responsibleParty"::text <> 'ENTREPRENEUR' THEN
        RAISE EXCEPTION 'Action item % is the MENTOR''s; the business owner may complete only items assigned to the ENTREPRENEUR.', OLD."id";
      END IF;
      IF NEW."status"::text <> 'DONE' OR NEW."title" IS DISTINCT FROM OLD."title"
         OR NEW."description" IS DISTINCT FROM OLD."description"
         OR NEW."responsibleParty" IS DISTINCT FROM OLD."responsibleParty"
         OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate" THEN
        RAISE EXCEPTION 'The business owner may only mark action item % DONE; nothing else about it may change.', OLD."id";
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
