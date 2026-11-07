import { describe, expect, it } from "vitest";

import { generateLicenseSerial } from "./license-serial";

describe("vendor license serials", () => {
  it("generates a readable year-bound serial from random bytes", () => {
    const serial = generateLicenseSerial(
      new Date("2026-11-05T12:00:00.000Z"),
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    );
    expect(serial).toMatch(/^CLX-2026-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it("does not derive the serial from a customer or installation identifier", () => {
    const first = generateLicenseSerial(new Date("2027-01-01T00:00:00.000Z"), Buffer.alloc(8, 0));
    const second = generateLicenseSerial(
      new Date("2027-01-01T00:00:00.000Z"),
      Buffer.alloc(8, 255),
    );
    expect(first).not.toBe(second);
    expect(first.startsWith("CLX-2027-")).toBe(true);
    expect(second.startsWith("CLX-2027-")).toBe(true);
  });
});
