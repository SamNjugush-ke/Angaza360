// ===========================================================================
// Secret scrubbing for provider diagnostics (M4.5 W1, T-B1).
//
// A live verify stores and returns the provider's error IN WORDS. Providers are not
// supposed to echo a credential back, but "should not" is not a guarantee — so before
// any such text leaves a factory, every stored field value is replaced. Short values
// (under 4 characters) are left alone: they cannot be secrets worth the name and would
// otherwise mangle ordinary words.
// ===========================================================================

export function scrubSecrets(text: string, values: ReadonlyArray<string | undefined>): string {
  let scrubbed = text;
  const secrets = values
    .filter((value): value is string => typeof value === "string" && value.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    scrubbed = scrubbed.split(secret).join("[redacted]");
  }
  return scrubbed;
}
