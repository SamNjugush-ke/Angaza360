import { describe, expect, it } from "vitest";
import { metadata } from "@/app/(app)/layout";

describe("the authenticated area stays out of the index (FP-SEO)", () => {
  it("is noindex, nofollow", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
