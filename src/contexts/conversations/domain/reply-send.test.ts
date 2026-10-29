import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/shared/errors";
import { MAX_LINKEDIN_REPLY } from "./linkedin-reply";
import { MANUAL_BODY_MAX } from "./manual-reply";
import { checkAccountReady, checkDraftCurrent, checkNoneInFlight, checkRecordOpen, checkReplyText, checkThreadWritable, NEWER_MESSAGE, REPLY_REFUSALS, replyRefusal, staleDraftRefusal } from "./reply-send";

const ACCOUNT = "4f6c1f6e-7a0b-4c55-9d7e-2b1c3a4d5e6f";

/** What a check threw: the class and the sentence, or null when it passed. */
function refusal(run: () => unknown): { error: string; message: string; details?: unknown } | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof ConflictError) return { error: "conflict", message: error.message, ...(error.details ? { details: error.details } : {}) };
    if (error instanceof ValidationError) return { error: "validation", message: error.message };
    throw error;
  }
}

describe("checkRecordOpen", () => {
  it("refuses closed reply handling and passes every other state", () => {
    expect(refusal(() => checkRecordOpen({ workflowState: "closed" }, "email"))).toEqual({ error: "conflict", message: "Reply handling is marked done. Reopen it to reply." });
    expect(refusal(() => checkRecordOpen({ workflowState: "closed" }, "linkedin"))).toEqual({ error: "conflict", message: "Reply handling is marked done. Reopen it to reply." });
    for (const workflowState of ["unclassified", "action_required", "waiting", "idle", "paused", "error"]) expect(refusal(() => checkRecordOpen({ workflowState }, "email"))).toBeNull();
  });
});

describe("checkThreadWritable", () => {
  const email = { channel: "email", status: "active", email: "ada@acme.test" };
  const chat = { channel: "linkedin", status: "active", chat: "chat-1", accountRef: ACCOUNT };

  it("passes an active conversation of the channel with somewhere to send to", () => {
    expect(refusal(() => checkThreadWritable(email, "email"))).toBeNull();
    expect(refusal(() => checkThreadWritable(chat, "linkedin"))).toBeNull();
  });

  it("refuses another channel's conversation, in the channel's words", () => {
    expect(refusal(() => checkThreadWritable(chat, "email"))).toEqual({ error: "conflict", message: "This is not an email conversation." });
    expect(refusal(() => checkThreadWritable(email, "linkedin"))).toEqual({ error: "conflict", message: "This is not a LinkedIn conversation." });
  });

  it("refuses a closed conversation before its recipient", () => {
    expect(refusal(() => checkThreadWritable({ ...email, status: "closed", email: null }, "email"))).toEqual({ error: "conflict", message: "This conversation is closed." });
    expect(refusal(() => checkThreadWritable({ ...chat, status: "closed", chat: null }, "linkedin"))).toEqual({ error: "conflict", message: "This conversation is closed." });
  });

  it("refuses an email conversation whose person has no address", () => {
    expect(refusal(() => checkThreadWritable({ ...email, email: null }, "email"))).toEqual({ error: "conflict", message: "This person has no email address." });
  });

  it("refuses a LinkedIn conversation with no chat, then one whose account ref is not an account id", () => {
    expect(refusal(() => checkThreadWritable({ ...chat, chat: null, accountRef: "jo@linkedin" }, "linkedin"))).toEqual({ error: "conflict", message: "There is no LinkedIn chat for this conversation yet." });
    expect(refusal(() => checkThreadWritable({ ...chat, accountRef: "jo@linkedin" }, "linkedin"))).toEqual({ error: "conflict", message: "No LinkedIn account is connected for this conversation." });
  });
});

describe("checkNoneInFlight", () => {
  it("passes when nothing is in flight", () => {
    expect(refusal(() => checkNoneInFlight(undefined, "d1", "email"))).toBeNull();
    expect(refusal(() => checkNoneInFlight(null, null, "linkedin"))).toBeNull();
  });

  it("names another reply in flight per channel, sending or unconfirmed", () => {
    expect(refusal(() => checkNoneInFlight({ id: "d2", status: "sending" }, "d1", "email"))).toEqual({ error: "conflict", message: "A reply is already being sent in this thread." });
    expect(refusal(() => checkNoneInFlight({ id: "d2", status: "sending" }, null, "linkedin"))).toEqual({ error: "conflict", message: "A reply is already being sent in this chat." });
    expect(refusal(() => checkNoneInFlight({ id: "d2", status: "delivery_uncertain" }, null, "email"))).toEqual({
      error: "conflict",
      message: "An earlier reply in this thread has an unconfirmed outcome. Check the mailbox and mark what you found first.",
    });
    expect(refusal(() => checkNoneInFlight({ id: "d2", status: "delivery_uncertain" }, "d1", "linkedin"))).toEqual({
      error: "conflict",
      message: "An earlier reply in this chat has an unconfirmed outcome. Check LinkedIn and mark what you found first.",
    });
  });

  it("gives the draft's own status when the draft being sent is the one in flight, whatever the id's case", () => {
    expect(refusal(() => checkNoneInFlight({ id: "abc-def", status: "delivery_uncertain" }, "ABC-DEF", "linkedin"))).toEqual({ error: "conflict", message: "This draft is delivery uncertain and cannot be sent." });
  });
});

describe("checkDraftCurrent", () => {
  const draft = { status: "awaiting_review", error: null, revision: 2, expectedContextVersion: 5 };
  const expected = { revision: 2, contextVersion: 5 };

  it("passes the reviewed revision of an awaiting draft written for the current version", () => {
    expect(checkDraftCurrent(draft, expected, "email")).toBeNull();
  });

  it("names why a stale draft went stale, with a fallback for a stale draft with no reason", () => {
    expect(refusal(() => checkDraftCurrent({ ...draft, status: "stale", error: "A person changed the reply type after this draft was written." }, expected, "email"))).toEqual({
      error: "conflict",
      message: "A person changed the reply type after this draft was written. Review the thread and regenerate the draft.",
    });
    expect(refusal(() => checkDraftCurrent({ ...draft, status: "stale", error: "The conversation became private" }, expected, "linkedin"))?.message).toBe(
      "The conversation became private. Review the thread and regenerate the draft.",
    );
    expect(refusal(() => checkDraftCurrent({ ...draft, status: "stale", error: null }, expected, "email"))?.message).toBe("This draft is out of date. Review the thread and regenerate the draft.");
  });

  it("refuses any other settled status with the status in words", () => {
    expect(refusal(() => checkDraftCurrent({ ...draft, status: "discarded" }, expected, "email"))).toEqual({ error: "conflict", message: "This draft is discarded and cannot be sent." });
    expect(refusal(() => checkDraftCurrent({ ...draft, status: "delivery_uncertain" }, expected, "linkedin"))?.message).toBe("This draft is delivery uncertain and cannot be sent.");
  });

  it("refuses a revision other than the reviewed one before it looks at the version", () => {
    expect(refusal(() => checkDraftCurrent(draft, { revision: 3, contextVersion: 6 }, "email"))).toEqual({ error: "conflict", message: "The draft changed since you reviewed it. Reload and approve the current text." });
  });

  it("returns the newer-message reason when only the version moved, and the refusal the store throws names it", () => {
    expect(checkDraftCurrent(draft, { revision: 2, contextVersion: 6 }, "linkedin")).toBe(NEWER_MESSAGE);
    expect(staleDraftRefusal(NEWER_MESSAGE, "email").message).toBe("A newer message arrived after this draft was written. Review the thread and regenerate the draft.");
  });
});

describe("checkReplyText", () => {
  it("folds CRLF and trims", () => {
    expect(checkReplyText("  hi\r\nthere \n", "linkedin")).toBe("hi\nthere");
  });

  it("refuses empty text as a validation error with one sentence on both channels", () => {
    for (const channel of ["email", "linkedin"] as const) expect(refusal(() => checkReplyText(" \r\n ", channel))).toEqual({ error: "validation", message: "The reply cannot be empty." });
  });

  it("caps the text at the channel's limit", () => {
    expect(checkReplyText("x".repeat(MAX_LINKEDIN_REPLY), "linkedin")).toHaveLength(MAX_LINKEDIN_REPLY);
    expect(refusal(() => checkReplyText("x".repeat(MAX_LINKEDIN_REPLY + 1), "linkedin"))).toEqual({ error: "validation", message: `The reply is longer than ${MAX_LINKEDIN_REPLY} characters.` });
    expect(checkReplyText("x".repeat(MAX_LINKEDIN_REPLY + 1), "email")).toHaveLength(MAX_LINKEDIN_REPLY + 1);
    expect(refusal(() => checkReplyText("x".repeat(MANUAL_BODY_MAX + 1), "email"))?.message).toBe(`The reply is longer than ${MANUAL_BODY_MAX} characters.`);
  });
});

describe("checkAccountReady", () => {
  it("passes no block, and answers a block with its reason as code and the gap's wait", () => {
    expect(refusal(() => checkAccountReady(null))).toBeNull();
    expect(refusal(() => checkAccountReady({ reason: "daily_cap", message: "Cap." }))).toEqual({ error: "conflict", message: "Cap.", details: { code: "daily_cap" } });
    expect(refusal(() => checkAccountReady({ reason: "too_fast", message: "Wait.", retryAfterSeconds: 4 }))).toEqual({ error: "conflict", message: "Wait.", details: { code: "too_fast", retryAfterSeconds: 4 } });
  });
});

describe("REPLY_REFUSALS", () => {
  it("answers a body the person can fix with a validation error and every other reason with a conflict", () => {
    const validation = Object.entries(REPLY_REFUSALS)
      .filter(([, row]) => row.error === ValidationError)
      .map(([reason]) => reason);
    expect(validation).toEqual(["empty_text", "text_too_long"]);
    expect(replyRefusal("no_chat", "linkedin")).toBeInstanceOf(ConflictError);
  });
});
