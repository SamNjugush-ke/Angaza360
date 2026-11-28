// A HINT for someone choosing a password — not a rule. The one rule is the backend's (at least
// 10 characters), and the form mirrors only that; this rates what was typed so the field can say
// "longer is stronger" in words while they type.

export const MIN_PASSWORD_LENGTH = 10;

export type PasswordStrength = "too-short" | "fair" | "good" | "strong";

export const STRENGTH_LABEL: Readonly<Record<PasswordStrength, string>> = {
  "too-short": "Too short",
  fair: "Fair",
  good: "Good",
  strong: "Strong",
};

export function passwordStrength(password: string): PasswordStrength {
  if (password.length < MIN_PASSWORD_LENGTH) return "too-short";
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((kind) => kind.test(password)).length;
  if (password.length >= 16 || (password.length >= 12 && kinds >= 3)) return "strong";
  if (password.length >= 12 || kinds >= 3) return "good";
  return "fair";
}
