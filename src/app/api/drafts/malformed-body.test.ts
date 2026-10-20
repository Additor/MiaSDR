import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: async () => undefined };
});
vi.mock("@/contexts/identity/infrastructure/session", () => ({
  apiOrgContext: async () => ({ user: { id: "u" }, organization: { id: "o" }, role: "member" }),
}));
vi.mock("@/contexts/conversations/ai/infrastructure/ai-composition", () => ({ replyDeps: () => ({}) }));

const post = (body: string) => new Request("http://x.test/api", { method: "POST", body, headers: { "content-type": "application/json" } });
const params = { params: Promise.resolve({ id: "d" }) } as never;

describe("draft routes answer 400 for a bad body", () => {
  it("send: invalid JSON, short key, missing fields", async () => {
    const { POST } = await import("./[id]/send/route");
    expect((await POST(post("{nope"), params)).status).toBe(400);
    expect((await POST(post(JSON.stringify({ revision: 1, idempotencyKey: "short" })), params)).status).toBe(400);
    expect((await POST(post("{}"), params)).status).toBe(400);
  });
  it("resolve and edit", async () => {
    const resolve = await import("./[id]/resolve/route");
    expect((await resolve.POST(post("{nope"), params)).status).toBe(400);
    const edit = await import("./[id]/route");
    expect((await edit.PATCH(post("[]"), params)).status).toBe(400);
  });
});
