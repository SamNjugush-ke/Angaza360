import type { Metadata } from "next";
import { People } from "@/components/people/people";
import { guarded } from "@/lib/auth/guard";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "People & access" };

async function PeoplePage() {
  // The nav opens this to the owner only (the API's people-management guards are owner-only; the
  // staff list alone also admits a manager). The signed-in user's id marks their own row, whose
  // role and active state are not changed from here.
  const session = await requireSession();
  return <People selfId={session.user.id} />;
}

export default guarded(PeoplePage);
