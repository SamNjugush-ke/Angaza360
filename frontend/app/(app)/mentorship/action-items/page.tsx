import type { Metadata } from "next";
import { MentorActionItems } from "@/components/mentorship/mentor";
import { guarded } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "Action items" };

function ActionitemsPage() {
  // The mentor's and coach's alone (the nav, and the API's MENTOR / COACH guards).
  return <MentorActionItems />;
}

export default guarded(ActionitemsPage);
