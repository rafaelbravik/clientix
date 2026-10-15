import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSupportContext: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({
  readSupportContext: mocks.readSupportContext,
}));

import { readSupportContext as readVendorSupportContext } from "./support-context-provider";
import { readSupportContext as readCustomerSupportContext } from "./support-context-provider.customer";
import {
  isSupportReadonly as isVendorSupportReadonly,
  supportRole as vendorSupportRole,
} from "./support-readonly-provider";
import {
  isSupportReadonly as isCustomerSupportReadonly,
  supportRole as customerSupportRole,
} from "./support-readonly-provider.customer";
import type { SupportContext } from "./support-context";

describe("provider do contexto de suporte por build target", () => {
  beforeEach(() => mocks.readSupportContext.mockReset());

  it("customer retorna contexto vazio sem consultar persistência", async () => {
    const db = { rpc: vi.fn() };

    await expect(readCustomerSupportContext(db as never)).resolves.toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(mocks.readSupportContext).not.toHaveBeenCalled();
  });

  it("vendor delega ao provider de suporte existente", async () => {
    const db = { rpc: vi.fn() };
    mocks.readSupportContext.mockResolvedValue(null);

    await expect(readVendorSupportContext(db as never)).resolves.toBeNull();
    expect(mocks.readSupportContext).toHaveBeenCalledWith(db);
  });

  it("vendor preserva o bloqueio somente leitura e o papel de suporte", () => {
    const readonly = { access_mode: "support_readonly" } as SupportContext;
    const full = { access_mode: "full" } as SupportContext;

    expect(isVendorSupportReadonly(readonly)).toBe(true);
    expect(isVendorSupportReadonly(full)).toBe(false);
    expect(vendorSupportRole(readonly)).toBe("viewer");
    expect(vendorSupportRole(full)).toBe("admin");
  });

  it("customer não reconhece nem aplica um modo de suporte", () => {
    const supplied = { access_mode: "support_readonly" };

    expect(isCustomerSupportReadonly(supplied)).toBe(false);
    expect(customerSupportRole(supplied)).toBe("viewer");
  });
});
