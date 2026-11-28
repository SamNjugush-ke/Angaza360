-- ===========================================================================
-- Task T-A6.3 — a COMMITTED batch is final.
--
-- PREVIEW -> COMMITTED once, terminal; born PREVIEW; who uploaded it and when never
-- change; a batch is never deleted (its rows and their decisions refer to it). A
-- COMMITTED batch carries its commit time and a PREVIEW one carries none (CHECK, ending
-- ELSE false).
-- ===========================================================================

ALTER TABLE "onboarding_batches" ADD CONSTRAINT "onboarding_batch_status_coherent" CHECK (
  CASE "status"::text
    WHEN 'PREVIEW' THEN "committedAt" IS NULL
    WHEN 'COMMITTED' THEN "committedAt" IS NOT NULL
    ELSE false
  END
);

CREATE OR REPLACE FUNCTION public.onboarding_batch_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'PREVIEW' THEN
      RAISE EXCEPTION 'An onboarding batch is uploaded as a PREVIEW (got %).', NEW."status";
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Onboarding batch % cannot be deleted: its rows and their decisions refer to it.', OLD."id";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."uploadedById" IS DISTINCT FROM OLD."uploadedById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Onboarding batch %: who uploaded it and when never change.', OLD."id";
  END IF;
  IF OLD."status"::text = 'COMMITTED' THEN
    RAISE EXCEPTION 'Onboarding batch % is COMMITTED, which is final.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER onboarding_batch_guard_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public."onboarding_batches"
  FOR EACH ROW EXECUTE FUNCTION public.onboarding_batch_guard();
