import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: async () => undefined };
});
vi.mock("@/contexts/identity/infrastructure/session", () => ({
  apiOrgContext: async () => ({ user: { id: "u" }, organization: { id: "o" }, role: "member" }),
}));
vi.mock("@/contexts/conversations/infrastructure/reply-handling-composition", () => ({ replyHandlingDeps: () => ({}) }));

const params = { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }) } as never;
const get = (query: string) => new Request(`http://x.test/api/records/r/reply-type/outcomes${query}`);

describe("type change outcomes route", () => {
  it("answers 400 for a missing or unknown path", async () => {
    const { GET } = await import("./route");
    expect((await GET(get(""), params)).status).toBe(400);
    expect((await GET(get("?path=sideways"), params)).status).toBe(400);
  });
});
