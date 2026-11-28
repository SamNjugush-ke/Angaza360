import type { Metadata } from "next";
import { Users } from "@/components/admin/users";
import { guarded } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "Users" };

function UsersPage() {
  // SUPER_ADMIN only: the nav and the API (/v1/users admits no PROGRAM_OFFICER).
  return <Users />;
}

export default guarded(UsersPage);
