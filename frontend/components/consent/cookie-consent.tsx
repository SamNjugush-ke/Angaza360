"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  CONSENT_OPEN_EVENT,
  consentNeeded,
  readAnalyticsConsent,
  setAnalyticsConsent,
  type AnalyticsConsent,
} from "@/lib/analytics/consent";

// THE COOKIE BANNER (M4.5 W2 — T-B3's consent banner). Essential cookies (sign-in, security,
// your working preferences) are always on and need no consent. Analytics stays OFF until the
// visitor accepts, the choice is recorded (lib/analytics/consent.ts — what, under which policy
// version, when), and it can be changed at any time from "Cookie settings" in the footer.
// Declining is one click, exactly like accepting.

export function CookieBanner() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<AnalyticsConsent | null>(null);
  const titleId = useId();
  const firstButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // The choice lives in a cookie the server render cannot see; read it once mounted.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(consentNeeded(document.cookie));
    setCurrent(readAnalyticsConsent(document.cookie));
    const reopen = () => {
      setCurrent(readAnalyticsConsent(document.cookie));
      setOpen(true);
    };
    window.addEventListener(CONSENT_OPEN_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, reopen);
  }, []);

  useEffect(() => {
    if (open && current !== null) firstButton.current?.focus();
  }, [open, current]);

  if (!open) return null;

  const choose = (value: AnalyticsConsent) => {
    setAnalyticsConsent(value);
    setCurrent(value);
    setOpen(false);
  };

  return (
    <section
      role="region"
      aria-labelledby={titleId}
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-card p-4 shadow-lg print:hidden sm:inset-x-auto sm:bottom-4 sm:right-4 sm:max-w-md sm:rounded-lg sm:border"
    >
      <h2 id={titleId} className="text-base font-semibold">
        Cookies on Angaza360
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Essential cookies keep you signed in and secure — they are always on. With your permission we would also use
        analytics cookies to understand how the product is used. They stay off unless you accept.{" "}
        <Link href="/cookies" className="font-medium text-primary underline-offset-4 hover:underline">
          Cookie Policy
        </Link>
      </p>
      {current !== null ? (
        <p className="mt-2 text-sm" role="status">
          Analytics is currently {current === "granted" ? "allowed" : "off"}.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button ref={firstButton} type="button" className="h-11" onClick={() => choose("granted")}>
          Accept analytics
        </Button>
        <Button type="button" variant="outline" className="h-11" onClick={() => choose("denied")}>
          Essential only
        </Button>
      </div>
    </section>
  );
}

/** Reopens the banner, so a choice can be changed or withdrawn at any time. */
export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new Event(CONSENT_OPEN_EVENT))}>
      Cookie settings
    </button>
  );
}
