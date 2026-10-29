import { describe, expect, it } from "vitest";
import { checkLeadDelete, deleteConfirmation, deleteQualification } from "./lead-delete-check";
import { BLOCK_MESSAGES } from "./lead-management";
import type { LeadDeleteDeps } from "./lead-ports";

describe("deleteQualification", () => {
  it("says a lead qualifies and what its absence of blockers means", () => {
    const q = deleteQualification(null);
    expect(q.canDelete).toBe(true);
    expect(q.summary).toBe("This lead can be deleted.");
    expect(q.detail).toMatch(/No message was sent/);
  });

  it.each(["has_sends", "personal_campaign_sends", "in_active_campaign", "linked_records"] as const)("says a lead blocked by %s cannot be deleted and gives the server's own reason", (reason) => {
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
  it("reads the person, the outreach blockers and the history with the actor's organization, without locks", async () => {
    const calls: string[] = [];
    const deps = {
      transaction: (fn: (tx: unknown) => Promise<unknown>) => fn("tx"),
      people: {
        read: async (_tx: unknown, org: string, ids: string[]) => {
          calls.push(`read ${org} ${ids.join()}`);
          return [{ id: "lead-1", name: "Lena", contact: false }];
        },
        lock: async () => calls.push("lock"),
      },
      outreach: {
        lockEnrollments: async () => calls.push("lockEnrollments"),
        blockers: async (_tx: unknown, actor: { organizationId: string }, ids: string[]) => {
          calls.push(`blockers ${actor.organizationId} ${ids.join()}`);
          return new Map([["lead-1", ["in_active_campaign"]]]);
        },
      },
      handling: {
        peopleWithHistory: async (_tx: unknown, org: string, ids: string[]) => {
          calls.push(`history ${org} ${ids.join()}`);
          return new Set<string>();
        },
      },
    } as unknown as LeadDeleteDeps;
    const q = await checkLeadDelete(deps, { organizationId: "org-1" } as never, "lead-1");
    expect(calls).toEqual(["read org-1 lead-1", "blockers org-1 lead-1", "history org-1 lead-1"]);
    expect(q).toMatchObject({ canDelete: false, detail: BLOCK_MESSAGES.in_active_campaign });
  });
});
