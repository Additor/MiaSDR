import { describe, expect, it } from "vitest";
import { ConflictError } from "@/shared/errors";
import { previewStore, type Preview } from "./import";

const preview = (organizationId: string, userId: string, expiresAt = 1000): Preview => ({ organizationId, userId, headers: [], rows: [], mapping: {}, defaultCountry: undefined, csvHash: "", expiresAt });
const actor = (organizationId: string, userId: string) => ({ organizationId, userId, role: "member" as const });

describe("import preview store", () => {
  it("replaces a person's oldest preview past their limit and keeps everyone else's", () => {
    const store = previewStore({ perPerson: 2, total: 10 });
    store.keep("a1", preview("org-a", "ann"), 0);
    store.keep("b1", preview("org-b", "bo"), 0);
    store.keep("a2", preview("org-a", "ann"), 0);
    store.keep("a3", preview("org-a", "ann"), 0);

    expect(() => store.take("a1", actor("org-a", "ann"), 1)).toThrow(ConflictError);
    expect(store.take("a2", actor("org-a", "ann"), 1).organizationId).toBe("org-a");
    expect(store.take("b1", actor("org-b", "bo"), 1).userId).toBe("bo");
  });

  it("refuses a new preview when the store is full instead of dropping another organization's", () => {
    const store = previewStore({ perPerson: 2, total: 2 });
    store.keep("a1", preview("org-a", "ann", 60_000), 0);
    store.keep("a2", preview("org-a", "cy", 90_000), 0);

    let refusal: unknown;
    try {
      store.keep("b1", preview("org-b", "bo"), 10_000);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConflictError);
    expect((refusal as ConflictError).details).toMatchObject({ code: "import_busy", retryAfterSeconds: 50 });
    expect(store.take("a1", actor("org-a", "ann"), 10_000).userId).toBe("ann");

    store.keep("b1", preview("org-b", "bo", 100_000), 10_000);
    expect(store.take("b1", actor("org-b", "bo"), 10_000).organizationId).toBe("org-b");
  });

  it("drops expired previews before it counts", () => {
    const store = previewStore({ perPerson: 2, total: 1 });
    store.keep("a1", preview("org-a", "ann", 100), 0);
    store.keep("b1", preview("org-b", "bo", 1000), 200);
    expect(store.take("b1", actor("org-b", "bo"), 300).userId).toBe("bo");
  });
});
