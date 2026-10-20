import { describe, expect, it } from "vitest";
import { ValidationError } from "@/shared/errors";
import { ingestInboundLinkedIn } from "./ingest-inbound-linkedin";
import type { InboundLinkedInInput, InboundLinkedInStore } from "./linkedin-ports";
import type { IngestResult, QuarantineInbound, UnresolvedResult } from "./ports";

function setup(answer: IngestResult | UnresolvedResult = { status: "created", conversationId: "c", messageId: "m", personId: "p", personCreated: false }) {
  const seen: InboundLinkedInInput[] = [];
  const parked: Parameters<QuarantineInbound>[0][] = [];
  const store: InboundLinkedInStore = {
    ingestLinkedIn: async (input) => {
      seen.push(input);
      return answer;
    },
  };
  const quarantine: QuarantineInbound = async (q) => {
    parked.push(q);
    return { id: "ex-1", created: true };
  };
  return { deps: { store, quarantine }, seen, parked };
}

const input = (partial: Partial<InboundLinkedInInput> = {}): InboundLinkedInInput => ({
  organizationId: "org",
  accountRef: "acc-1",
  accountName: "Jo Owner",
  providerThreadId: "chat-1",
  providerMessageId: "msg-1",
  counterparty: { providerId: "ACo1", name: "Ada Lovelace", profileUrl: "https://www.linkedin.com/in/ada", slug: "ada" },
  personId: null,
  bodyText: "Sounds good",
  receivedAt: new Date("2026-10-14T10:00:00Z"),
  ...partial,
});

describe("ingestInboundLinkedIn", () => {
  it("passes a normalized message to the store", async () => {
    const { deps, seen } = setup();
    await ingestInboundLinkedIn(deps, input({ accountName: "  ", counterparty: { providerId: " ACo1 ", name: " Ada ", profileUrl: " ", slug: " ADA " } }));
    expect(seen[0]).toMatchObject({ accountName: null, counterparty: { providerId: "ACo1", name: "Ada", profileUrl: null, slug: "ada" } });
  });

  it("stores a message with no text under a placeholder body", async () => {
    const { deps, seen } = setup();
    await ingestInboundLinkedIn(deps, input({ bodyText: "  \n" }));
    expect(seen[0].bodyText).toBe("(no text content)");
  });

  it("rejects a message without account, id, chat or sender", async () => {
    const { deps, seen } = setup();
    await expect(ingestInboundLinkedIn(deps, input({ accountRef: " " }))).rejects.toBeInstanceOf(ValidationError);
    await expect(ingestInboundLinkedIn(deps, input({ providerMessageId: "" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(ingestInboundLinkedIn(deps, input({ providerThreadId: "" }))).rejects.toThrow(/no chat id/);
    await expect(ingestInboundLinkedIn(deps, input({ counterparty: { providerId: "", name: null, profileUrl: null, slug: null } }))).rejects.toThrow(/no sender/);
    expect(seen).toEqual([]);
  });

  it("parks a message the store cannot tie to a person, keeping the normalized message", async () => {
    const { deps, parked } = setup({ status: "unresolved", reason: "no identity", identityValue: "ACo1" });
    const out = await ingestInboundLinkedIn(deps, input({ bodyText: "  \n", counterparty: { providerId: "ACo1", name: null, profileUrl: null, slug: null } }));
    expect(out).toEqual({ status: "quarantined", exceptionId: "ex-1", reason: "no identity" });
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ organizationId: "org", sourceEventKey: "linkedin:acc-1:msg-1", identityValue: "ACo1", payload: { kind: "linkedin", message: { providerMessageId: "msg-1", bodyText: "(no text content)", receivedAt: "2026-10-14T10:00:00.000Z" } } });
  });

  it("parks nothing when the store files the message", async () => {
    const { deps, parked } = setup();
    expect((await ingestInboundLinkedIn(deps, input())).status).toBe("created");
    expect(parked).toEqual([]);
  });
});
