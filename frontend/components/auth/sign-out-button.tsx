"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast/toast";
import { Button } from "@/components/ui/button";
import { CSRF_HEADER, readCsrfToken } from "@/lib/auth/csrf-shared";

export function SignOutButton() {
  const router = useRouter();
  const { failure } = useToast();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { [CSRF_HEADER]: readCsrfToken(document.cookie) ?? "" },
      });
      if (response.status !== 204) throw new Error(`Sign-out failed: HTTP ${response.status}`);
      // The sign-in page raises the "Signed out" toast (this shell, and its toasts, unmount).
      router.replace("/login?reason=signed-out");
      router.refresh();
    } catch {
      failure("You’re still signed in. Please try again.");
      setPending(false);
    }
  }

  return (
    <Button type="button" variant="outline" className="min-h-11" onClick={signOut} disabled={pending}>
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
