import { describe, expect, it } from "vitest";
import { checkLeadDelete, deleteConfirmation, deleteQualification } from "./lead-delete-check";
import { BLOCK_MESSAGES } from "./lead-management";
import type { LeadDeps } from "./lead-ports";

describe("deleteQualification", () => {
  it("says a lead qualifies and what its absence of blockers means", () => {
    const q = deleteQualification(null);
    expect(q.canDelete).toBe(true);
    expect(q.summary).toBe("This lead can be deleted.");
    expect(q.detail).toMatch(/No message was sent/);
  });

  it.each(["has_sends", "in_active_campaign", "linked_records"] as const)("says a lead blocked by %s cannot be deleted and gives the server's own reason", (reason) => {
    const q = deleteQualification(reason);
    expect(q.canDelete).toBe(false);
    expect(q.summary).toBe("This lead cannot be deleted.");
    expect(q.detail).toBe(BLOCK_MESSAGES[reason]);
  });
});

describe("deleteConfirmation", () => {
  it("names what is removed, what is protected, and that this lead qualifies", () => {
    const text = deleteConfirmation(deleteQualification(null));
    expect(text).toContain("This lead can be deleted.");
    expect(text).toContain("cannot be undone");
    expect(text).toContain("protected");
    expect(text).toContain("do not contact");
  });

  it("states the block when a stale page still offers the dialog", () => {
    expect(deleteConfirmation(deleteQualification("has_sends"))).toContain("This lead cannot be deleted.");
  });
});

describe("checkLeadDelete", () => {
  it("asks the repository with the actor's organization", async () => {
    const calls: Array<[string, string]> = [];
    const deps = {
      leads: {
        deleteBlock: async (org: string, id: string) => {
          calls.push([org, id]);
          return "in_active_campaign" as const;
        },
      },
    } as unknown as LeadDeps;
    const q = await checkLeadDelete(deps, { organizationId: "org-1" } as never, "lead-1");
    expect(calls).toEqual([["org-1", "lead-1"]]);
    expect(q.canDelete).toBe(false);
  });
});
