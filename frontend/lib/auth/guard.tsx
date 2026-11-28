import "server-only";

import { headers } from "next/headers";
import type { ReactNode } from "react";
import { NotAuthorizedState } from "@/components/states/states";
import { decideAccess } from "@/lib/nav/access";
import { ROLE_LANDING } from "./landing";
import { PATHNAME_HEADER } from "./names";
import { requireSession } from "./session";

// The route-level access guard. EVERY page in the authenticated area is exported through
// guarded() (a test enforces it), because the check has to run on every render of the page: a
// layout does not re-render on client-side navigation, so a check there would be skipped by an
// in-app link. The path comes from the header the proxy always overwrites; the allowed roles come
// from the nav config (lib/nav/access.ts). A role that may not open the path gets the in-shell
// 403 state, never the page.

/** Wraps a page so it renders only for a role allowed at the requested path. */
export function guarded<P>(Page: (props: P) => ReactNode | Promise<ReactNode>) {
  return async function GuardedPage(props: P): Promise<ReactNode> {
    const session = await requireSession();
    const pathname = (await headers()).get(PATHNAME_HEADER);
    // While acting as a business (god-mode), a SUPER_ADMIN may also open that business's own
    // (merchant / mentorship) screens — they are operating as its owner. Their console access stays.
    const decision = decideAccess(session.role, pathname);
    const allowed = decision.allowed || (session.actingAs ? decideAccess("MSME_OWNER", pathname).allowed : false);
    if (!allowed) return <NotAuthorizedState section={decision.section} homeHref={ROLE_LANDING[session.role]} />;
    return Page(props);
  };
}
