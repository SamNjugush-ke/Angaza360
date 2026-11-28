"use client";

// Pieces the Business setup tabs share: a definition list of facts (an empty one reads "Not set",
// never a blank), and the note a reader who may not change anything sees.

export function Facts({ label, facts }: { label: string; facts: ReadonlyArray<readonly [string, string | null]> }) {
  return (
    <dl aria-label={label} className="max-w-2xl text-sm">
      {facts.map(([name, value]) => (
        <div key={name} className="flex flex-col gap-0.5 border-b py-2 last:border-b-0 sm:flex-row sm:justify-between sm:gap-4">
          <dt className="text-muted-foreground">{name}</dt>
          <dd className={value ? "break-words sm:text-right" : "text-muted-foreground sm:text-right"}>{value ?? "Not set"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ReadOnlyNote() {
  return <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">Only the business owner can change these. Ask the owner if something here needs updating.</p>;
}
