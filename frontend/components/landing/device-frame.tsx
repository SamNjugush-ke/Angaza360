import type { ReactNode } from "react";
import { SITE_URL } from "@/lib/brand";
import { cn } from "@/lib/utils";

/** The address bar reads the app's own host, derived from the brand source of truth. */
const APP_ADDRESS = `app.${new URL(SITE_URL).host}`;

// The device frames the landing page's product glimpses sit in, drawn by hand as inline SVG: a
// browser window (the back office and the till on a tablet or laptop) and a phone (M-Pesa). The
// SVG is the bezel only and stretches with its box (no viewBox, so the corners never distort);
// the screen is real HTML on top of it, so the figures stay crisp and legible at any width.
//
// A glimpse is an illustration, so the frame is one role="img" with a written description; the
// text inside is not read out a second time.

interface FrameProps {
  /** What the glimpse shows, for a screen reader. */
  label: string;
  children: ReactNode;
  className?: string;
}

export function BrowserFrame({ label, children, className }: FrameProps) {
  return (
    <div role="img" aria-label={label} className={cn("relative rounded-[18px] p-2 pt-9 shadow-[0_24px_60px_-28px_rgb(var(--angaza-navy)/0.45)]", className)}>
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" focusable="false">
        <rect x="0" y="0" width="100%" height="100%" rx="18" className="fill-angaza-navy" />
        <circle cx="20" cy="18" r="4" className="fill-angaza-white/30" />
        <circle cx="34" cy="18" r="4" className="fill-angaza-white/30" />
        <circle cx="48" cy="18" r="4" className="fill-angaza-white/30" />
        <rect x="66" y="9" width="52%" height="18" rx="9" className="fill-angaza-white/10" />
        <text x="80" y="22" fontSize="11" className="fill-angaza-white/75 font-sans">
          {APP_ADDRESS}
        </text>
      </svg>
      <div className="relative overflow-hidden rounded-[10px] bg-card text-card-foreground">{children}</div>
    </div>
  );
}

export function PhoneFrame({ label, children, className }: FrameProps) {
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("relative mx-auto w-full max-w-[17rem] rounded-[34px] p-2.5 pt-8 shadow-[0_24px_60px_-28px_rgb(var(--angaza-navy)/0.5)]", className)}
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" focusable="false">
        <rect x="0" y="0" width="100%" height="100%" rx="34" className="fill-angaza-navy" />
        <svg x="50%" y="12" overflow="visible">
          <rect x="-28" y="0" width="56" height="10" rx="5" className="fill-angaza-black/60" />
          <circle cx="18" cy="5" r="2" className="fill-angaza-white/25" />
        </svg>
      </svg>
      <div className="relative overflow-hidden rounded-[24px] bg-card text-card-foreground">{children}</div>
    </div>
  );
}
