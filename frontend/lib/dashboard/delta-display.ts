// How a period-over-period change reads: sign, arrow AND words — never colour alone. A missing
// comparison (no prior figure, or a prior loss) reads as a dash with a plain explanation.

export type DeltaDirection = "up" | "down" | "flat" | "none";

export interface DeltaDisplay {
  direction: DeltaDirection;
  /** What is shown: "+5.3%", "−2.1%", "0.0%" or "—". */
  text: string;
  /** What a screen reader hears. */
  description: string;
}

const percent = new Intl.NumberFormat("en-KE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function deltaDisplay(delta: number | null | undefined, comparedWith: string): DeltaDisplay {
  if (delta === null || delta === undefined) {
    return { direction: "none", text: "—", description: `No comparison with ${comparedWith}` };
  }
  const magnitude = percent.format(Math.abs(delta));
  if (magnitude === "0.0") return { direction: "flat", text: "0.0%", description: `Unchanged on ${comparedWith}` };
  return delta > 0
    ? { direction: "up", text: `+${magnitude}%`, description: `Up ${magnitude}% on ${comparedWith}` }
    : { direction: "down", text: `−${magnitude}%`, description: `Down ${magnitude}% on ${comparedWith}` };
}
