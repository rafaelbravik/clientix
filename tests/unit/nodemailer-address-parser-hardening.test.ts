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

  it.each([
    ["plain mailbox", "v@victim.test", ["v@victim.test"]],
    ["display name", "Victim <v@victim.test>", ["v@victim.test"]],
    ["ordinary comment", "Victim (comment) <v@victim.test>", ["v@victim.test"]],
    ["comment address", "Victim (evil@evil.test) <v@victim.test>", ["v@victim.test"]],
    ["comma in quoted display name", '"Doe, Jane" <jane@victim.test>', ["jane@victim.test"]],
    ["quoted display name", '"Jane Q." <jane@victim.test>', ["jane@victim.test"]],
    ["multiple mailboxes", "a@one.test, b@two.test", ["a@one.test", "b@two.test"]],
    ["nested comments", "Victim (outer (inner)) <v@victim.test>", ["v@victim.test"]],
  ])("keeps the intended address for %s", (_label, input, expected) => {
    expect(recipients(parseAddressList(input))).toEqual(expected);
  });

  it("fails closed when malformed comment syntax yields no mailbox", () => {
    const parsed = parseAddressList("Victim (x(y) <evil@evil.test>");
    expect(recipients(parsed)).toEqual([]);
  });

  it("preserves the parser's empty-list result", () => {
    expect(parseAddressList("")).toEqual([]);
  });
});
