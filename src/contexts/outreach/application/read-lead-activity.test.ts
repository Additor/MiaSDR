import { describe, expect, it, vi } from "vitest";
import { NEW_LEAD_STATUS, type LeadStatus, type ReadLeadStatuses } from "../domain/lead-status";
import { NO_REACH, reachability, type ReadReachability } from "../domain/reachability";
import { readLeadActivity } from "./read-lead-activity";

const lead = (id: string, email: string | null = null, linkedinSlug: string | null = null, lifecycle = "lead") => ({ id, lifecycle, email, linkedinSlug, linkedinUrl: null });

describe("readLeadActivity", () => {
  it("makes one call to each outreach read for the whole set and merges contact points", async () => {
    const replied: LeadStatus = { state: "replied", enrollment: null, otherCampaigns: 0, lastContactAt: new Date("2026-10-01T10:00:00Z") };
    const reach = reachability({ doNotContact: null, email: "a@x.com", suppression: { reason: "bounced", since: null }, hasLinkedin: false });
    const readStatuses = vi.fn<ReadLeadStatuses>(async () => new Map([["a", replied]]));
    const readReach = vi.fn<ReadReachability>(async () => new Map([["a", reach]]));
    const map = await readLeadActivity({ readStatuses, readReach }, "org-1", [lead("a", "a@x.com"), lead("b", null, "bee")]);
    expect(readStatuses).toHaveBeenCalledTimes(1);
    expect(readStatuses).toHaveBeenCalledWith("org-1", ["a", "b"]);
    expect(readReach).toHaveBeenCalledWith("org-1", ["a", "b"]);
    expect(map.get("a")).toMatchObject({ status: replied, reach, contact: { email: { href: "mailto:a@x.com" }, linkedin: null } });
    expect(map.get("b")).toMatchObject({ status: NEW_LEAD_STATUS, reach: NO_REACH, contact: { email: null, linkedin: { href: "https://www.linkedin.com/in/bee/" } } });
  });

  it("gives a contact no status and keeps its reach", async () => {
    const reach = reachability({ doNotContact: null, email: "c@x.com", suppression: null, hasLinkedin: false });
    const readStatuses = vi.fn<ReadLeadStatuses>(async () => new Map());
    const readReach = vi.fn<ReadReachability>(async () => new Map([["c", reach]]));
    const map = await readLeadActivity({ readStatuses, readReach }, "org-1", [lead("c", "c@x.com", null, "contact")]);
    expect(map.get("c")).toMatchObject({ status: null, reach });
    expect(readStatuses).not.toHaveBeenCalled();
  });

  it("does not call outreach for an empty set", async () => {
    const readStatuses = vi.fn<ReadLeadStatuses>(async () => new Map());
    const readReach = vi.fn<ReadReachability>(async () => new Map());
    expect((await readLeadActivity({ readStatuses, readReach }, "org-1", [])).size).toBe(0);
    expect(readStatuses).not.toHaveBeenCalled();
    expect(readReach).not.toHaveBeenCalled();
  });
});
