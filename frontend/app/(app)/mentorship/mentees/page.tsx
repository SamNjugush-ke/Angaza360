import type { Metadata } from "next";
import { MentorEngagements } from "@/components/mentorship/mentor";
import { guarded } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "Mentees" };

function MenteesPage() {
  // The mentor's and coach's alone (the nav, and the API's MENTOR / COACH guards).
  return <MentorEngagements onlyActive />;
}

export default guarded(MenteesPage);
