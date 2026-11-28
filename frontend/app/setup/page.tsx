import { redirect } from "next/navigation";

// /setup is the short address for the first-login guided setup. The checklist itself lives under
// /dashboard (/dashboard/setup) so it inherits the dashboard's session guard and role access.
export default function SetupAlias(): never {
  redirect("/dashboard/setup");
}
