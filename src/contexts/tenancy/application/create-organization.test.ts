import { describe, expect, it, vi } from "vitest";
import { createOrganization, type CreateOrganizationDeps } from "./create-organization";

function deps(overrides: Partial<CreateOrganizationDeps> = {}): { deps: CreateOrganizationDeps; created: string[] } {
  const created: string[] = [];
  return {
    created,
    deps: {
      mayCreate: async () => true,
      store: {
        slugsStartingWith: async () => [],
        createWithOwner: async (input) => {
          created.push(input.slug);
          return { id: `id-${created.length}` };
        },
      },
      active: { set: async () => undefined },
      ...overrides,
    },
  };
}

describe("createOrganization", () => {
  it("keeps the organization when switching to it fails, so a retry does not create a second one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps: d, created } = deps({ active: { set: async () => Promise.reject(new Error("session gone")) } });
    const result = await createOrganization(d, { userId: "u1" }, { name: "Acme" });
    expect(result).toEqual({ id: "id-1", name: "Acme", slug: "acme" });
    expect(created).toEqual(["acme"]);
  });
});
