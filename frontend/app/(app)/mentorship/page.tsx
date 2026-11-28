import type { Metadata } from "next";
import { MentorEngagements } from "@/components/mentorship/mentor";
import { OwnerMentorship } from "@/components/mentorship/owner";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Mentorship" };

async function MentorshipPage() {
  // /mentorship is two pages by role: a mentor's or coach's engagements, and a business owner's
  // view of the mentoring on their own business (the nav opens it to those three roles only).
  const session = await requireSession();
  if (session.role === "MENTOR" || session.role === "COACH") return <MentorEngagements />;
  return <OwnerMentorship />;
}

export default guarded(MentorshipPage);
