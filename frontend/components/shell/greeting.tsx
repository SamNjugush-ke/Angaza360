"use client";

import { createContext, useContext, type ReactNode } from "react";
import { firstNameOf, greetingFor } from "@/lib/dashboard/greeting";
import type { ShellContext } from "./types";

// WHO IS SIGNED IN, for the pages inside the shell (M4.5 W3). The greeting addresses the PERSON by
// their first name — "Good morning, Wanjiku" — and the business (or the workspace) is context
// beside it, never the salutation. Display data only; no token.

const SignedInContext = createContext<ShellContext | null>(null);

export function SignedInProvider({ context, children }: { context: ShellContext; children: ReactNode }) {
  return <SignedInContext.Provider value={context}>{children}</SignedInContext.Provider>;
}

export function useSignedIn(): ShellContext | null {
  return useContext(SignedInContext);
}

/** "Good morning, Wanjiku", by the Nairobi clock. Falls back to the bare greeting with no name. */
export function greetingLine(fullName: string, now: Date = new Date()): string {
  const name = firstNameOf(fullName);
  return name ? `${greetingFor(now)}, ${name}` : greetingFor(now);
}

/**
 * A workspace home page's greeting: one short line above its heading, with the business or
 * workspace as context. Not a heading — the page keeps its one h1.
 */
export function Greeting({ context }: { context?: string }) {
  const signedIn = useSignedIn();
  if (!signedIn) return null;
  const where = context ?? signedIn.contextName;
  return (
    <p className="text-sm text-muted-foreground" suppressHydrationWarning>
      <span className="font-medium text-foreground">{greetingLine(signedIn.fullName)}</span>
      {where ? ` · ${where}` : ""}
    </p>
  );
}
