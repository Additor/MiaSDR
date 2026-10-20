import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ org: null as null | { organization: { id: string } } }));
const lookups = vi.hoisted(() => ({ calls: [] as Array<[string, string]>, conversation: null as null | { conversationId: string; channel: string } }));

vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/contexts/identity/infrastructure/session", () => ({ apiOrgContext: async () => session.org }));
vi.mock("@/contexts/conversations/infrastructure/person-handling", () => ({
  activeConversationOfRecord: async (org: string, id: string) => (lookups.calls.push([org, id]), lookups.conversation),
}));

import { GET } from "./route";
import { GET as LIST } from "../route";

const RECORD = "0b6f0c8e-1111-4222-8333-444455556666";
const call = (id: string) => GET(new Request(`http://localhost/crm/records/${id}`), { params: Promise.resolve({ id }) } as never);

describe("/crm/records/[id] deep link", () => {
  beforeEach(() => {
    session.org = { organization: { id: "org1" } };
    lookups.calls = [];
    lookups.conversation = null;
  });

  it("opens the person's active-channel public conversation with a temporary redirect", async () => {
    lookups.conversation = { conversationId: "conv-1", channel: "linkedin" };
    const response = await call(RECORD);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/inbox/conv-1");
    expect(lookups.calls).toEqual([["org1", RECORD]]);
  });

  it.each([
    ["a record with no public conversation", RECORD, { org: { organization: { id: "org1" } }, conversation: null }],
    ["a signed-out visitor", RECORD, { org: null, conversation: { conversationId: "conv-1", channel: "email" } }],
    ["an id that is not a UUID", "nope", { org: { organization: { id: "org1" } }, conversation: { conversationId: "conv-1", channel: "email" } }],
  ])("falls back to the Pipeline for %s", async (_name, id, state) => {
    session.org = state.org;
    lookups.conversation = state.conversation;
    const response = await call(id);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/crm/pipeline");
    if (id === "nope" || !state.org) expect(lookups.calls).toEqual([]);
  });
});

describe("/crm/records list", () => {
  it("opens Leads with a conversation in every lifecycle and keeps only the search", async () => {
    const response = await LIST(new Request("http://localhost/crm/records?q=%20ada%40x.test%20&state=closed&category=interested&page=3"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/leads?hasConversation=yes&lifecycle=all&q=ada%40x.test");
  });

  it("leaves the search out when there is none", async () => {
    const response = await LIST(new Request("http://localhost/crm/records?state=closed"));
    expect(response.headers.get("location")).toBe("/leads?hasConversation=yes&lifecycle=all");
  });
});
