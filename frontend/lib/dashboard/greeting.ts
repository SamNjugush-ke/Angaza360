import { BUSINESS_TZ } from "@/lib/datetime";

// A time-aware greeting, by the clock in Nairobi (where the business is), not the browser's.

const hourFormatter = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: BUSINESS_TZ });

export function greetingFor(now: Date = new Date()): string {
  const hour = Number(hourFormatter.format(now));
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** The first word of a full name — "Wanjiku Kamau" → "Wanjiku". */
export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}
