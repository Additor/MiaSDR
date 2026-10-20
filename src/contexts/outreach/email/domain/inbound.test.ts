import { describe, expect, it } from "vitest";
import { classifyInbound, isAutoReply } from "./inbound";

const DAEMON = "Mail Delivery Subsystem <mailer-daemon@googlemail.com>";
const BOUNCE_BODY = "Your message wasn't delivered to jane@acme.com because the address couldn't be found.";

describe("isAutoReply", () => {
  it("flags Auto-Submitted values other than no", () => {
    expect(isAutoReply({ subject: "Re: Hi", headers: { "auto-submitted": "auto-replied" } })).toBe(true);
    expect(isAutoReply({ subject: "Re: Hi", headers: { "Auto-Submitted": "auto-generated" } })).toBe(true);
    expect(isAutoReply({ subject: "Re: Hi", headers: { "auto-submitted": "no" } })).toBe(false);
  });

  it("flags bulk and junk precedence", () => {
    expect(isAutoReply({ subject: "Re: Hi", headers: { precedence: "bulk" } })).toBe(true);
    expect(isAutoReply({ subject: "Re: Hi", headers: { precedence: "Junk" } })).toBe(true);
    expect(isAutoReply({ subject: "Re: Hi", headers: { precedence: "list" } })).toBe(false);
  });

  it("flags out-of-office subjects", () => {
    expect(isAutoReply({ subject: "Automatic reply: Hi", headers: {} })).toBe(true);
    expect(isAutoReply({ subject: "Out of Office: back Monday", headers: {} })).toBe(true);
    expect(isAutoReply({ subject: "Re: out of the box idea", headers: {} })).toBe(false);
  });

  it("leaves a plain reply alone", () => {
    expect(isAutoReply({ subject: "Re: Hi", headers: {} })).toBe(false);
  });
});

describe("classifyInbound", () => {
  const base = { subject: "Re: Hi", bodyText: "Sounds good", headers: {} };

  it("classifies a hard and a soft bounce", () => {
    expect(classifyInbound("me@corp.test", { ...base, from: DAEMON, subject: "Delivery Status Notification (Failure)", bodyText: BOUNCE_BODY })).toEqual({
      kind: "hard_bounce",
      failedRecipient: "jane@acme.com",
    });
    expect(
      classifyInbound("me@corp.test", { ...base, from: DAEMON, subject: "Delivery Status Notification (Failure)", bodyText: `${BOUNCE_BODY}\nThe mailbox is full.` }),
    ).toMatchObject({ kind: "soft_bounce" });
  });

  it("does not treat a bounce for our own mailbox as a bounce", () => {
    const result = classifyInbound("jane@acme.com", { ...base, from: DAEMON, subject: "Delivery Status Notification (Failure)", bodyText: BOUNCE_BODY });
    expect(result.kind).not.toBe("hard_bounce");
  });

  it("treats a failure-looking message from the failed recipient as a human reply", () => {
    const result = classifyInbound("me@corp.test", { ...base, from: "Jane <jane@acme.com>", subject: "Undeliverable: Hi", headers: { "auto-submitted": "auto-replied" }, bodyText: BOUNCE_BODY });
    expect(result.kind).toBe("auto_reply");
    const human = classifyInbound("me@corp.test", { ...base, from: "jane@acme.com", headers: { "content-type": "multipart/report; report-type=delivery-status" }, bodyText: BOUNCE_BODY });
    expect(human).toEqual({ kind: "message" });
  });

  it("recognizes our own message and auto-replies", () => {
    expect(classifyInbound("me@corp.test", { ...base, from: "Me <ME@corp.test>" })).toEqual({ kind: "own_message" });
    expect(classifyInbound("me@corp.test", { ...base, from: "jane@acme.com", headers: { precedence: "bulk" } })).toEqual({ kind: "auto_reply" });
    expect(classifyInbound("me@corp.test", { ...base, from: "jane@acme.com" })).toEqual({ kind: "message" });
  });
});
