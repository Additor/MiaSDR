import { describe, expect, it } from "vitest";
import { resolveThreading } from "./threading";

const sent = [
  { subject: "Hello", rfcMessageId: "<a@x>", providerThreadId: "t1" },
  { subject: "", rfcMessageId: "<b@x>", providerThreadId: "t1" },
];

describe("resolveThreading", () => {
  it("starts a new message when the step has a subject", () => {
    expect(resolveThreading("New topic", sent)).toEqual({ subject: "New topic", inReplyTo: null, references: [], providerThreadId: null });
  });
  it("replies in the thread of the latest send that had a subject", () => {
    expect(resolveThreading("", sent)).toEqual({
      subject: "Re: Hello",
      inReplyTo: "<a@x>",
      references: ["<a@x>", "<b@x>"],
      providerThreadId: "t1",
    });
  });
  it("does not stack Re:", () => {
    expect(resolveThreading("", [{ subject: "Re: Hello", rfcMessageId: "<a@x>", providerThreadId: null }]).subject).toBe("Re: Hello");
  });
  it("has nothing to reply to on a first step with no subject", () => {
    expect(resolveThreading("", [])).toEqual({ subject: "", inReplyTo: null, references: [], providerThreadId: null });
  });
});
