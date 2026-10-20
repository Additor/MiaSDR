import { describe, expect, it } from "vitest";
import { parseUnipilePayload } from "../unipile-webhook";

describe("parseUnipilePayload", () => {
  it("reads a new_relation as an acceptance", () => {
    expect(parseUnipilePayload({ event: "new_relation", account_id: "a1", account_type: "LINKEDIN", user_provider_id: "ACo1", user_full_name: "Ada", user_profile_url: "https://x" })).toEqual({
      type: "connection_accepted",
      account: "a1",
      member: "ACo1",
      name: "Ada",
      profileUrl: "https://x",
    });
  });

  it("reads an inbound message with the sender as counterparty", () => {
    const event = parseUnipilePayload({
      event: "message_received",
      account_id: "a1",
      account_type: "LINKEDIN",
      account_info: { user_id: "ME" },
      chat_id: "c1",
      message_id: "m1",
      message: "Hello",
      sender: { attendee_provider_id: "ACo1", attendee_name: "Ada Lovelace", attendee_profile_url: "https://www.linkedin.com/in/ada" },
      timestamp: "2026-10-14T10:00:00.000Z",
    });
    expect(event).toEqual({
      type: "message_received",
      account: "a1",
      chat: "c1",
      messageId: "m1",
      text: "Hello",
      fromAccountOwner: false,
      counterparty: "ACo1",
      counterpartyName: "Ada Lovelace",
      counterpartyProfileUrl: "https://www.linkedin.com/in/ada",
      sentAt: "2026-10-14T10:00:00.000Z",
    });
  });

  it("recognizes our own message and finds the other attendee", () => {
    const event = parseUnipilePayload({
      event: "message_received",
      account_id: "a1",
      account_type: "LINKEDIN",
      account_info: { user_id: "ME" },
      message_id: "m2",
      message: "Hi",
      sender: { attendee_provider_id: "ME" },
      attendees: [{ attendee_provider_id: "ME" }, { attendee_provider_id: "ACo9" }],
    });
    expect(event).toMatchObject({ fromAccountOwner: true, counterparty: "ACo9" });
  });

  it("ignores other accounts types, events and malformed bodies", () => {
    expect(parseUnipilePayload({ event: "new_relation", account_id: "a", account_type: "WHATSAPP", user_provider_id: "x" })).toBeNull();
    expect(parseUnipilePayload({ event: "message_read", account_id: "a", account_type: "LINKEDIN" })).toBeNull();
    expect(parseUnipilePayload({ event: "new_relation", account_id: "a", account_type: "LINKEDIN" })).toBeNull();
    expect(parseUnipilePayload("nope")).toBeNull();
    expect(parseUnipilePayload(null)).toBeNull();
  });
});
