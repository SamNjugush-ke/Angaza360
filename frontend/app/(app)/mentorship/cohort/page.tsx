import type { Metadata } from "next";
import { MentorCohort } from "@/components/mentorship/mentor";
import { guarded } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "Cohort" };

function CohortPage() {
  // The mentor's and coach's alone (the nav, and the API's MENTOR / COACH guards).
  return <MentorCohort />;
}

export default guarded(CohortPage);
