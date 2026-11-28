"use client";

import { useEffect, useState } from "react";
import { analyticsEnabled, CONSENT_CHANGED_EVENT, readAnalyticsConsent } from "@/lib/analytics/consent";

// The ONE injection point for analytics (GA4 / GTM). It renders NOTHING unless
// NEXT_PUBLIC_GA_ID is set AND the visitor has granted consent; consent is read after mount, so
// the server render and the first client render never contain it. No tracker script is
// included: when one is adopted, it mounts inside the slot below and nowhere else.

export function Analytics({ measurementId = process.env.NEXT_PUBLIC_GA_ID }: { measurementId?: string }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    // Consent lives in a cookie the server render cannot see; read it once mounted, and again
    // whenever the banner records a new choice (a withdrawal switches the slot off at once).
    const read = () => setEnabled(analyticsEnabled(measurementId, readAnalyticsConsent(document.cookie)));
    read();
    window.addEventListener(CONSENT_CHANGED_EVENT, read);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, read);
  }, [measurementId]);

  if (!enabled) return null;
  return <div hidden data-analytics-slot={measurementId} />;
}
