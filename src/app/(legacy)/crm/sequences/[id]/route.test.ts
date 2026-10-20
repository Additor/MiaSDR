import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ org: null as null | { organization: { id: string } } }));
const lookups = vi.hoisted(() => ({ calls: [] as Array<[string, string]>, campaign: null as string | null }));

vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/contexts/identity/infrastructure/session", () => ({ apiOrgContext: async () => session.org }));
vi.mock("@/contexts/conversations/after-reply/infrastructure/sequence-composition", () => ({
  campaignIdOfSequence: async (org: string, id: string) => (lookups.calls.push([org, id]), lookups.campaign),
}));

import { GET } from "./route";

const SEQUENCE = "0b6f0c8e-1111-4222-8333-444455556666";
const call = (id: string) => GET(new Request(`http://localhost/crm/sequences/${id}`), { params: Promise.resolve({ id }) } as never);

describe("/crm/sequences/[id] deep link", () => {
  beforeEach(() => {
    session.org = { organization: { id: "org1" } };
    lookups.calls = [];
    lookups.campaign = null;
  });

  it("sends a sequence of a campaign to that campaign's After a reply setting with a temporary redirect", async () => {
    lookups.campaign = "camp-1";
    const response = await call(SEQUENCE);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/campaigns/camp-1?tab=settings");
    expect(lookups.calls).toEqual([["org1", SEQUENCE]]);
  });

  it.each([
    ["a legacy sequence with no campaign", SEQUENCE, { org: { organization: { id: "org1" } }, campaign: null }],
    ["a signed-out visitor", SEQUENCE, { org: null, campaign: "camp-1" }],
    ["an id that is not a UUID", "nope", { org: { organization: { id: "org1" } }, campaign: "camp-1" }],
  ])("falls back to the campaign list for %s", async (_name, id, state) => {
    session.org = state.org;
    lookups.campaign = state.campaign;
    const response = await call(id);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/campaigns");
    if (id === "nope" || !state.org) expect(lookups.calls).toEqual([]);
  });
});
