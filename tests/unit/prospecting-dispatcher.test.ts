import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROSPECTING_PROVIDER,
  providerNameForOrganization,
  providerNameFromSettings,
  updateProspectingProvider,
} from "@/lib/prospecting/dispatcher";
import { ProspectingError } from "@/lib/prospecting/provider";
import { prospectingInputSchema } from "@/lib/prospecting/schema";

describe("prospecting provider selection", () => {
  it("keeps Apify as the default when organization settings do not select a provider", () => {
    expect(DEFAULT_PROSPECTING_PROVIDER).toBe("apify");
    expect(providerNameFromSettings(null)).toBe("apify");
    expect(providerNameFromSettings({})).toBe("apify");
    expect(providerNameFromSettings({ prospecting: {} })).toBe("apify");
  });

  it("accepts only supported providers and fails closed on malformed configuration", () => {
    expect(providerNameFromSettings({ prospecting: { provider: "apify" } })).toBe("apify");
    expect(providerNameFromSettings({ prospecting: { provider: "local-http" } })).toBe("local-http");
    expect(() => providerNameFromSettings({ prospecting: { provider: "unknown" } })).toThrowError(
      expect.objectContaining({ status: 422 }),
    );
    expect(() => providerNameFromSettings({ prospecting: "local-http" })).toThrowError(ProspectingError);
  });

  it("derives the setting from an explicit organization-scoped query", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ settings: { prospecting: { provider: "local-http" } } }] });
    await expect(providerNameForOrganization({ query }, "org-a")).resolves.toBe("local-http");
    expect(query).toHaveBeenCalledWith("select settings from organizations where id=$1", ["org-a"]);
  });

  it("writes provider selection through an organization-scoped JSON settings update", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await expect(updateProspectingProvider({ query }, "org-a", "local-http")).resolves.toBeUndefined();
    expect(query.mock.calls[0]![0]).toContain("update organizations");
    expect(query.mock.calls[0]![0]).toContain("where id = $1");
    expect(query.mock.calls[0]![1]).toEqual(["org-a", "local-http"]);
    await expect(
      updateProspectingProvider({ query: vi.fn().mockResolvedValue({ rowCount: 0 }) }, "org-a", "apify"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("does not accept a tenant-controlled endpoint or source in the selection action", () => {
    expect(prospectingInputSchema.safeParse({ action: "select_provider", provider: "local-http" }).success).toBe(true);
    expect(
      prospectingInputSchema.safeParse({
        action: "select_provider",
        provider: "local-http",
        organization_id: "org-b",
        url: "http://attacker.invalid",
      }).success,
    ).toBe(false);
  });
});
