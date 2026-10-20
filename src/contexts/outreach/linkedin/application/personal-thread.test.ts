import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, type Actor } from "@/shared/errors";
import type { CampaignType } from "../../domain/campaign";
import { readPersonalThread, type PersonalThreadStore } from "./personal-thread";

const AT = new Date("2026-10-14T10:00:00Z");

function store(options: { type?: CampaignType; createdBy?: string | null; lead?: boolean } = {}): PersonalThreadStore {
  return {
    campaign: async (org, id) => (org === "org1" && id === "c1" ? { id: "c1", name: "Quiet", type: options.type ?? "personal", createdBy: options.createdBy === undefined ? "creator" : options.createdBy } : null),
    thread: async (_org, _campaign, enrollment) => (options.lead === false || enrollment !== "e1" ? null : { personName: "Ada", messages: [{ id: "m1", direction: "inbound", at: AT, text: "Yes" }] }),
  };
}
const actor = (role: string, userId = "someone"): Actor => ({ userId, organizationId: "org1", role });

describe("readPersonalThread", () => {
  it("lets an owner and an admin read", async () => {
    for (const role of ["owner", "admin"]) {
      const thread = await readPersonalThread({ store: store() }, actor(role), "c1", "e1");
      expect(thread).toMatchObject({ campaignName: "Quiet", personName: "Ada", messages: [{ text: "Yes" }] });
    }
  });

  it("lets the campaign creator read, even as a member", async () => {
    await expect(readPersonalThread({ store: store() }, actor("member", "creator"), "c1", "e1")).resolves.toMatchObject({ personName: "Ada" });
  });

  it("refuses another member with a 403", async () => {
    await expect(readPersonalThread({ store: store() }, actor("member"), "c1", "e1")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a member when the creator account is gone", async () => {
    await expect(readPersonalThread({ store: store({ createdBy: null }) }, actor("member"), "c1", "e1")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("answers not found for a regular campaign, another organization or an unknown lead", async () => {
    await expect(readPersonalThread({ store: store({ type: "regular" }) }, actor("owner"), "c1", "e1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(readPersonalThread({ store: store() }, { ...actor("owner"), organizationId: "org2" }, "c1", "e1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(readPersonalThread({ store: store() }, actor("owner"), "c1", "nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});
