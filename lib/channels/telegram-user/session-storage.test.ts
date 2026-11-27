import { describe, expect, it } from "vitest";
import { sessionCiphertextForDatabase } from "./session-storage";

describe("sessionCiphertextForDatabase", () => {
  it("preserva o literal bytea hexadecimal devolvido pelo RPC", () => {
    expect(sessionCiphertextForDatabase("\\xc301ff")).toBe("\\xc301ff");
  });

  it("recusa a serialização JSON de Buffer que não é bytea", () => {
    expect(sessionCiphertextForDatabase('{"type":"Buffer","data":[195,1,255]}')).toBeNull();
  });

  it("recusa hex incompleto ou sem o prefixo bytea", () => {
    expect(sessionCiphertextForDatabase("\\xc30")).toBeNull();
    expect(sessionCiphertextForDatabase("c301ff")).toBeNull();
  });
});
