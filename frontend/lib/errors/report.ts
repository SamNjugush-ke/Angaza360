// What a client error boundary may write to the console: the error's NAME (and Next's opaque
// digest, which only correlates with the server log). Never the message or the stack — either
// can carry personal data or a token from a failed request.
export function reportBoundaryError(where: string, error: Error & { digest?: string }): void {
  console.error(`[${where}] render failed: ${error.name}${error.digest ? ` (digest ${error.digest})` : ""}`);
}
