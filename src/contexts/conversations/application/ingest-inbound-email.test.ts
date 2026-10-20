import { describe, expect, it } from "vitest";
import { ValidationError } from "@/shared/errors";
import { identityPayloadSchema } from "./crm";
import { ingestInboundEmail } from "./ingest-inbound-email";
import type { InboundConversationStore, InboundEmailInput, QuarantineInbound } from "./ports";

function setup() {
  const seen: InboundEmailInput[] = [];
  const parked: Parameters<QuarantineInbound>[0][] = [];
  const store: InboundConversationStore = {
    ingestEmail: async (input) => {
      seen.push(input);
      return { status: "created", conversationId: "c", messageId: "m", personId: "p", personCreated: false };
    },
  };
  const quarantine: QuarantineInbound = async (q) => {
    parked.push(q);
    return { id: "ex-1", created: true };
  };
  return { deps: { store, quarantine }, seen, parked };
}

const input = (partial: Partial<InboundEmailInput> = {}): InboundEmailInput => ({
  organizationId: "org",
  accountRef: "Sales@Us.test",
  providerThreadId: "t1",
  providerMessageId: "m1",
  rfcMessageId: null,
  inReplyTo: null,
  from: { email: " Ada@Acme.test ", name: " Ada " },
  to: ["sales@us.test"],
  subject: " Hi ",
  bodyText: "Hello",
  receivedAt: new Date("2026-10-14T10:00:00Z"),
  autoReply: false,
  ...partial,
});

describe("ingestInboundEmail", () => {
  it("files a normalized message", async () => {
    const { deps, seen, parked } = setup();
    expect((await ingestInboundEmail(deps, input())).status).toBe("created");
    expect(seen[0]).toMatchObject({ accountRef: "sales@us.test", from: { email: "ada@acme.test", name: "Ada" }, subject: "Hi" });
    expect(parked).toEqual([]);
  });

  it("parks a message with an unusable sender instead of dropping or throwing", async () => {
    const { deps, seen, parked } = setup();
    const out = await ingestInboundEmail(deps, input({ from: { email: "not-an-address", name: null }, possibleBounce: true }));
    expect(out).toMatchObject({ status: "quarantined", exceptionId: "ex-1" });
    expect(seen).toEqual([]);
    expect(parked[0]).toMatchObject({ organizationId: "org", sourceEventKey: "gmail:sales@us.test:m1", identityValue: "not-an-address" });
    // The stored payload must pass the replay schema, or the reviewer could never resolve it.
    expect(identityPayloadSchema.safeParse(parked[0].payload).success).toBe(true);
  });

  it("parks an empty sender address too", async () => {
    const { deps, parked } = setup();
    await ingestInboundEmail(deps, input({ from: { email: "  ", name: "Ghost" } }));
    expect(parked[0].identityValue).toBeNull();
    expect(identityPayloadSchema.safeParse(parked[0].payload).success).toBe(true);
  });

  it("files a reviewer's replay even though the stored sender is unusable", async () => {
    const { deps, seen, parked } = setup();
    await ingestInboundEmail(deps, input({ from: { email: "not-an-address", name: null }, personId: "person-1" }));
    expect(seen).toHaveLength(1);
    expect(parked).toEqual([]);
  });

  it("rejects a message with no mailbox or provider id", async () => {
    const { deps } = setup();
    await expect(ingestInboundEmail(deps, input({ accountRef: " " }))).rejects.toBeInstanceOf(ValidationError);
    await expect(ingestInboundEmail(deps, input({ providerMessageId: "" }))).rejects.toBeInstanceOf(ValidationError);
  });
});
