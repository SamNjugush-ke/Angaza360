import type { Metadata } from "next";
import { AccountSecurity } from "@/components/account/security";
import { guarded } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "Sign-in security" };

function AccountSecurityPage() {
  // Every role's OWN two-step verification (M4.5 W1). It reads and changes only the signed-in
  // person's settings; there is nothing here about anyone else.
  return <AccountSecurity />;
}

export default guarded(AccountSecurityPage);
