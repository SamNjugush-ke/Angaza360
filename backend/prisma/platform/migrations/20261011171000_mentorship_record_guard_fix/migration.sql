-- ===========================================================================
-- CORRECTION to 20261011170000 (Task 14.2), as a NEW migration because that one is
-- already recorded as applied — an applied migration is never edited.
--
-- The shared guard tested `TG_TABLE_NAME = '...' AND NEW."status" ...` in one
-- expression. plpgsql does not short-circuit field resolution, so on the two tables
-- WITHOUT a status column (mentorship_indicators, mentorship_sessions) every INSERT
-- failed with "record new has no field status". The table test and the field test are
-- now nested, so a column is only read on the table that has it. Behaviour is otherwise
-- identical.
-- ===========================================================================
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
    IF TG_TABLE_NAME IN ('mentorship_goals', 'mentorship_action_items') THEN
      IF NEW."status"::text <> 'OPEN' THEN
        RAISE EXCEPTION 'A record in % must be created OPEN (got %).', TG_TABLE_NAME, NEW."status";
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
  ELSIF OLD."status"::text IN ('DONE', 'CANCELLED') THEN
    RAISE EXCEPTION 'Action item % is % and terminal; it cannot be changed.', OLD."id", OLD."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
