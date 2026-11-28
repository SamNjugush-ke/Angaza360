import type { Metadata } from "next";
import { MentorSessions } from "@/components/mentorship/mentor";
import { guarded } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "Sessions" };

function SessionsPage() {
  // The mentor's and coach's alone (the nav, and the API's MENTOR / COACH guards).
  return <MentorSessions />;
}

export default guarded(SessionsPage);
