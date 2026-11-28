// THE PHONE NORMALISER (lib/phone.ts, the copy of backend/src/lib/phone.ts): lenient about how a
// number is written, strict about what it is. The SAME table as backend/test/unit/phone.test.ts.

import { describe, expect, it } from "vitest";
import { normalizePhone, PHONE_INVALID_MESSAGE, PHONE_MISSING_MESSAGE } from "@/lib/phone";

describe("normalizePhone", () => {
  it.each([
    ["0729866328"],
    ["+254729866328"],
    ["254729866328"],
    ["729866328"],
    ["0729 866 328"],
    ["0729-866-328"],
    ["(0729) 866.328"],
    ["+254 729 866 328"],
    ["00254729866328"],
  ])("reconciles %s to +254729866328", (input) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164: "+254729866328" });
  });

  it.each([
    ["+2348012345678", "+2348012345678"],
    ["+256 772 123 456", "+256772123456"],
    ["+44 20 7946 0958", "+442079460958"],
    ["0201234567", "+254201234567"],
  ])("keeps an explicit country, or reads a Kenyan landline: %s", (input, e164) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164 });
  });

  it("reads a local number in another default country", () => {
    expect(normalizePhone("0772123456", "UG")).toEqual({ ok: true, e164: "+256772123456" });
  });

  it.each([[""], ["   "], [null], [undefined]])("says a missing phone is missing: %s", (input) => {
    expect(normalizePhone(input)).toEqual({ ok: false, reason: "MISSING", message: PHONE_MISSING_MESSAGE });
  });

  it.each([["0712345"], ["07298663281"], ["+25471234567"], ["2348012345678"], ["phone"], ["0712 abc 678"], ["+"], ["++254729866328"]])(
    "refuses %s as not a valid phone number",
    (input) => {
      expect(normalizePhone(input)).toEqual({ ok: false, reason: "INVALID", message: PHONE_INVALID_MESSAGE });
    },
  );
});
