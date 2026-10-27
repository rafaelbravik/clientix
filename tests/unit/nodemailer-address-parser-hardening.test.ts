import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

type Address = { address?: string; group?: Address[] | null };
const require = createRequire(import.meta.url);
const parseAddressList = require("nodemailer/lib/addressparser") as (input: string) => Address[];

function recipients(addresses: Address[]): string[] {
  return addresses.flatMap((entry) =>
    entry.group ? recipients(entry.group) : entry.address ? [entry.address] : [],
  );
}

describe("Nodemailer recipient parsing hardening", () => {
  it("does not turn nested RFC comments into additional recipients", () => {
    const parsed = parseAddressList("Victim (x(y) <evil@evil.test>) <v@victim.test>");
    expect(recipients(parsed)).toEqual(["v@victim.test"]);
  });

  it("does not turn a malformed group/comment into additional recipients", () => {
    const parsed = parseAddressList("G: (a; <evil@evil.test>) <v@victim.test>;");
    expect(recipients(parsed)).toEqual(["v@victim.test"]);
  });
});
