// The 47 counties of Kenya, in the order of the First Schedule to the Constitution of Kenya
// (2010). Geography, not a statutory rate: it changes only by constitutional amendment.
// Used by the onboarding application (M4.5 W2), where the county drives admin analytics.

export const KENYA_COUNTIES = [
  "Mombasa",
  "Kwale",
  "Kilifi",
  "Tana River",
  "Lamu",
  "Taita-Taveta",
  "Garissa",
  "Wajir",
  "Mandera",
  "Marsabit",
  "Isiolo",
  "Meru",
  "Tharaka-Nithi",
  "Embu",
  "Kitui",
  "Machakos",
  "Makueni",
  "Nyandarua",
  "Nyeri",
  "Kirinyaga",
  "Murang'a",
  "Kiambu",
  "Turkana",
  "West Pokot",
  "Samburu",
  "Trans Nzoia",
  "Uasin Gishu",
  "Elgeyo-Marakwet",
  "Nandi",
  "Baringo",
  "Laikipia",
  "Nakuru",
  "Narok",
  "Kajiado",
  "Kericho",
  "Bomet",
  "Kakamega",
  "Vihiga",
  "Bungoma",
  "Busia",
  "Siaya",
  "Kisumu",
  "Homa Bay",
  "Migori",
  "Kisii",
  "Nyamira",
  "Nairobi",
] as const;

export type KenyaCounty = (typeof KENYA_COUNTIES)[number];

/** The canonical spelling of a county, matched case- and spacing-insensitively; null if unknown. */
export function canonicalCounty(value: string): KenyaCounty | null {
  const key = (text: string) => text.toLowerCase().replace(/[\s'-]/g, "");
  const wanted = key(value);
  return KENYA_COUNTIES.find((county) => key(county) === wanted) ?? null;
}
