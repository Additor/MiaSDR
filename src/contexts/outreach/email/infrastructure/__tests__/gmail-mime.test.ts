import { describe, expect, it } from "vitest";
import type { OutgoingEmail } from "../../application/ports";
import { buildMime } from "../gmail-mime";

const email: OutgoingEmail = {
  mailbox: { emailAddress: "sam@acme.com", displayName: "Sam Rivera" },
  to: "lead@example.com",
  subject: "Quick question",
  bodyText: "Hello there",
  bodyHtml: "<p>Hello there</p>",
  rfcMessageId: "<abc@acme.com>",
  inReplyTo: null,
  references: [],
  threadId: null,
  listUnsubscribeUrl: "https://app.example.com/unsubscribe?t=1",
};

const decodePart = (mime: string, type: string) => {
  const start = mime.indexOf(`Content-Type: ${type}`);
  const body = mime.slice(mime.indexOf("\r\n\r\n", start) + 4).split("\r\n--")[0] ?? "";
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
};

describe("buildMime", () => {
  it("writes the headers and both bodies", () => {
    const mime = buildMime(email, "B");
    expect(mime).toContain('From: "Sam Rivera" <sam@acme.com>\r\n');
    expect(mime).toContain("To: lead@example.com\r\n");
    expect(mime).toContain("Subject: Quick question\r\n");
    expect(mime).toContain("Message-ID: <abc@acme.com>\r\n");
    expect(mime).toContain("X-MiaSDR-Send-Id: <abc@acme.com>\r\n");    expect(mime).toContain("List-Unsubscribe: <https://app.example.com/unsubscribe?t=1>\r\n");
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n");
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="B"');
    expect(mime).not.toContain("In-Reply-To");
    expect(decodePart(mime, "text/plain")).toBe("Hello there");
    expect(decodePart(mime, "text/html")).toBe("<p>Hello there</p>");
    expect(mime.trimEnd().endsWith("--B--")).toBe(true);
  });

  it("encodes non-ASCII subjects and names as RFC 2047 words", () => {
    const mime = buildMime({ ...email, subject: "안녕하세요 질문이 있습니다 빠른 확인 부탁드립니다", mailbox: { emailAddress: "sam@acme.com", displayName: "김민수" } }, "B");
    const subject = mime.split("Subject: ")[1]!.split("\r\nMessage-ID")[0]!.replace(/\r\n /g, " ");
    const words = subject.split(" ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(words.every((w) => w.length <= 75)).toBe(true);
    const decoded = words.map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8")).join("");
    expect(decoded).toBe("안녕하세요 질문이 있습니다 빠른 확인 부탁드립니다");
    expect(mime).toContain(`From: =?UTF-8?B?${Buffer.from("김민수").toString("base64")}?= <sam@acme.com>`);
  });

  it("writes threading headers", () => {
    const mime = buildMime({ ...email, inReplyTo: "<p2@acme.com>", references: ["<p1@acme.com>", "<p2@acme.com>"] }, "B");
    expect(mime).toContain("In-Reply-To: <p2@acme.com>\r\n");
    expect(mime).toContain("References: <p1@acme.com> <p2@acme.com>\r\n");
  });

  it("escapes quotes in the display name", () => {
    expect(buildMime({ ...email, mailbox: { emailAddress: "sam@acme.com", displayName: 'Sam "S" R' } }, "B")).toContain('From: "Sam \\"S\\" R" <sam@acme.com>');
  });

  it.each([
    ["subject", { subject: "Hi\r\nBcc: x@evil.com" }],
    ["to", { to: "a@b.com\nBcc: x@evil.com" }],
    ["display name", { mailbox: { emailAddress: "sam@acme.com", displayName: "Sam\r\nBcc: x@evil.com" } }],
    ["message id", { rfcMessageId: "<a@b>\r\nX: y" }],
    ["in-reply-to", { inReplyTo: "<a@b>\r\nX: y" }],
    ["references", { references: ["<a@b>\nX: y"] }],
    ["unsubscribe url", { listUnsubscribeUrl: "https://x.com/\r\nBcc: x@evil.com" }],
  ])("rejects a line break in the %s", (_name, override) => {
    expect(() => buildMime({ ...email, ...override })).toThrow(/line break/);
  });
});

describe("buildMime cc", () => {
  it("writes no Cc header by default", () => {
    expect(buildMime(email, "B")).not.toMatch(/^Cc:/m);
  });
  it("writes one Cc header with every address", () => {
    expect(buildMime({ ...email, cc: ["a@x.com", "b@x.com"] }, "B")).toContain("Cc: a@x.com, b@x.com\r\n");
  });
  it("refuses a Cc address that carries a line break, a comma or brackets", () => {
    for (const bad of ["a@x.com\r\nBcc: evil@x.com", "a@x.com, evil@x.com", "<a@x.com>", "a b@x.com"]) {
      expect(() => buildMime({ ...email, cc: [bad] }, "B")).toThrow();
    }
  });
});
