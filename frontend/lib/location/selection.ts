// The working location: which of THIS business's locations the user is working at. A readable
// cookie, because the browser sets it and F1 screens read it. It holds a location id and nothing
// else — it is NOT a business switcher (the tenant always comes from the session), and an id
// that is not one of the session's own locations is simply ignored.

export const LOCATION_COOKIE = "ag_location";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export function readSelectedLocation(cookieString: string): string | null {
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === LOCATION_COOKIE) {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      return value === "" ? null : value;
    }
  }
  return null;
}

export function writeSelectedLocation(locationId: string): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCATION_COOKIE}=${encodeURIComponent(locationId)}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure}`;
}

/** The saved id when it is one of these locations; else the default location; else the first. */
export function resolveSelection<T extends { id: string; isDefault: boolean }>(locations: readonly T[], saved: string | null): T | null {
  return locations.find((l) => l.id === saved) ?? locations.find((l) => l.isDefault) ?? locations[0] ?? null;
}
