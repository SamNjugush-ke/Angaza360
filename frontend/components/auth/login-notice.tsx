"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/toast/toast";
import type { LoginReason } from "@/lib/auth/login-reason";

// Why the visitor is on the sign-in page, when the app sent them here: their session ended,
// they signed out, they reset their password, or they accepted an invitation. Raised ONCE as a
// toast, then the reason is taken off the address (the returnTo stays), so a reload does not
// repeat it. The reason is parsed on the server by lib/auth/login-reason.ts.

export function LoginNotice({ reason }: { reason: LoginReason | null }) {
  const { toast } = useToast();
  const shown = useRef(false);

  useEffect(() => {
    if (!reason || shown.current) return;
    shown.current = true;
    if (reason === "expired") {
      toast({ title: "Your session has ended", description: "Please sign in again.", tone: "info", duration: null });
    } else if (reason === "reset") {
      toast({ title: "Password reset", description: "Sign in with your new password.", tone: "success", duration: null });
    } else if (reason === "welcome") {
      toast({ title: "Welcome — your account is ready", description: "Please sign in.", tone: "success", duration: null });
    } else {
      toast({ title: "Signed out", tone: "success" });
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("reason");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }, [reason, toast]);

  return null;
}
