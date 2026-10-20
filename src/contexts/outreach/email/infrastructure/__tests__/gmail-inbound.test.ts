import { describe, expect, it } from "vitest";
import { decodeEncodedWords, htmlToText, parseGmailMessage, type GmailPart } from "../gmail-inbound";

const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64url");
const h = (name: string, value: string) => ({ name, value });
const text = (mimeType: string, body: string | Buffer, charset?: string): GmailPart => ({
  mimeType,
  headers: [h("Content-Type", charset ? `${mimeType}; charset="${charset}"` : mimeType)],
  body: { data: b64(body) },
});
const message = (payload: GmailPart, extra: Record<string, unknown> = {}) => ({ id: "m1", threadId: "t1", internalDate: "1700000000000", labelIds: ["INBOX"], payload, ...extra });
const baseHeaders = [h("From", '"Kim, Lee" <Lee@Example.com>'), h("To", "Sam <sam@acme.com>, other@acme.com"), h("Subject", "Re: hi"), h("Message-ID", "<id1@example.com>")];

describe("parseGmailMessage authentication headers", () => {
  it("records the first authentication-results and received-spf values, capped at 2000 characters", () => {
    const long = `mx.google.com; dkim=pass ${"x".repeat(3000)}`;
    const parsed = parseGmailMessage(
      message({
        mimeType: "text/plain",
        headers: [h("From", "a@b.com"), h("Authentication-Results", long), h("Authentication-Results", "forged; dmarc=pass"), h("Received-SPF", "pass (google.com: domain of a@b.com designates 1.2.3.4)")],
        body: { data: b64("x") },
      }),
    );
    expect(parsed.headers["authentication-results"]).toHaveLength(2000);
    expect(parsed.headers["authentication-results"]!.startsWith("mx.google.com; dkim=pass")).toBe(true);
    expect(parsed.headers["received-spf"]).toBe("pass (google.com: domain of a@b.com designates 1.2.3.4)");
  });

  it("omits them when the message has none", () => {
    const parsed = parseGmailMessage(message({ mimeType: "text/plain", headers: [h("From", "a@b.com")], body: { data: b64("x") } }));
    expect(parsed.headers).not.toHaveProperty("authentication-results");
    expect(parsed.headers).not.toHaveProperty("received-spf");
  });
});

describe("parseGmailMessage headers", () => {
  it("reads addresses, ids, references and date", () => {
    const parsed = parseGmailMessage(
      message({
        mimeType: "text/plain",
        headers: [...baseHeaders, h("In-Reply-To", "<a@acme.com>"), h("References", "<x@acme.com>\r\n <a@acme.com>"), h("Date", "Tue, 14 Nov 2023 22:13:20 +0000"), h("List-Id", "<l.example.com>"), h("X-Other", "no")],
        body: { data: b64("hello") },
      }),
    );
    expect(parsed).toMatchObject({
      providerMessageId: "m1",
      threadId: "t1",
      rfcMessageId: "<id1@example.com>",
      inReplyTo: "<a@acme.com>",
      references: ["<x@acme.com>", "<a@acme.com>"],
      from: { email: "lee@example.com", name: "Kim, Lee" },
      to: ["sam@acme.com", "other@acme.com"],
      bodyText: "hello",
      sendId: null,
    });
    expect(parsed.receivedAt.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(parsed.headers).toEqual({ "list-id": "<l.example.com>" });
  });

  it("falls back to internalDate and handles a bare From", () => {
    const parsed = parseGmailMessage(message({ mimeType: "text/plain", headers: [h("From", "a@b.com"), h("Date", "garbage")], body: { data: b64("x") } }));
    expect(parsed.receivedAt.getTime()).toBe(1_700_000_000_000);
    expect(parsed.from).toEqual({ email: "a@b.com", name: null });
  });

  it("decodes encoded-word subjects, joining adjacent words", () => {
    expect(decodeEncodedWords("=?UTF-8?B?7ZWc6rWt7Ja0?= =?UTF-8?Q?_=ED=85=8C=EC=8A=A4=ED=8A=B8?=")).toBe("한국어 테스트");
    expect(decodeEncodedWords("=?utf-8?q?Caf=C3=A9_menu?=")).toBe("Café menu");
    expect(decodeEncodedWords("plain")).toBe("plain");
  });

  it("keeps the send id from the header, angle brackets stripped", () => {
    const parsed = parseGmailMessage(message({ mimeType: "text/plain", headers: [h("X-MiaSDR-Send-Id", "<send-1@acme.com>")], body: { data: b64("x") } }));
    expect(parsed.sendId).toBe("send-1@acme.com");
    expect(parsed.headers["x-miasdr-send-id"]).toBe("<send-1@acme.com>");
  });
});

describe("parseGmailMessage body", () => {
  it("prefers text/plain in multipart/alternative", () => {
    const parsed = parseGmailMessage(
      message({ mimeType: "multipart/alternative", headers: baseHeaders, parts: [text("text/plain", "plain version"), text("text/html", "<p>html version</p>")] }),
    );
    expect(parsed.bodyText).toBe("plain version");
  });

  it("decodes Korean in euc-kr and utf-8", () => {
    const euc = new Uint8Array([0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4]); // 안녕하세요
    expect(parseGmailMessage(message(text("text/plain", Buffer.from(euc), "euc-kr"))).bodyText).toBe("안녕하세요");
    expect(parseGmailMessage(message(text("text/plain", "관심 있습니다", "utf-8"))).bodyText).toBe("관심 있습니다");
  });

  it("falls back to utf-8 for an unknown charset", () => {
    expect(parseGmailMessage(message(text("text/plain", "ok", "x-nonsense"))).bodyText).toBe("ok");
  });

  it("strips html when there is no plain part", () => {
    const html = "<html><head><style>p{}</style></head><body><p>Hi&nbsp;there &amp; welcome</p><div>Line two<br>three &#51060;</div></body></html>";
    const parsed = parseGmailMessage(message({ mimeType: "multipart/alternative", parts: [text("text/html", html)] }));
    expect(parsed.bodyText).toBe("Hi there & welcome\nLine two\nthree 이");
    expect(htmlToText("<script>x()</script>a &unknown; b")).toBe("a &unknown; b");
  });

  it("ignores attachments", () => {
    const attachment = { ...text("text/plain", "secret"), filename: "notes.txt" };
    const parsed = parseGmailMessage(message({ mimeType: "multipart/mixed", parts: [text("text/plain", "body"), attachment] }));
    expect(parsed.bodyText).toBe("body");
  });

  it("keeps delivery-status parts of a bounce and finds the send id in the returned headers", () => {
    const status = text("message/delivery-status", "Final-Recipient: rfc822; gone@example.com\nAction: failed\nStatus: 5.1.1");
    const original: GmailPart = { mimeType: "text/rfc822-headers", body: { data: b64("From: sam@acme.com\nX-MiaSDR-Send-Id: <send-9@acme.com>\nSubject: Hello") } };
    const parsed = parseGmailMessage(
      message({
        mimeType: "multipart/report",
        headers: [h("From", "Mail Delivery Subsystem <mailer-daemon@googlemail.com>"), h("Content-Type", "multipart/report; report-type=delivery-status"), h("X-Failed-Recipients", "gone@example.com")],
        parts: [text("text/plain", "Address not found"), status, original],
      }),
    );
    expect(parsed.bodyText).toContain("Address not found");
    expect(parsed.bodyText).toContain("Final-Recipient: rfc822; gone@example.com");
    expect(parsed.sendId).toBe("send-9@acme.com");
    expect(parsed.headers["x-failed-recipients"]).toBe("gone@example.com");
    expect(parsed.headers["content-type"]).toContain("multipart/report");
  });

  it("finds the send id in an attached message/rfc822 part", () => {
    const attached: GmailPart = { mimeType: "message/rfc822", parts: [{ mimeType: "text/plain", headers: [h("X-MiaSDR-Send-Id", "<send-5@acme.com>")], body: { data: b64("orig") } }] };
    const parsed = parseGmailMessage(message({ mimeType: "multipart/mixed", parts: [text("text/plain", "auto reply"), attached] }));
    expect(parsed.sendId).toBe("send-5@acme.com");
    expect(parsed.bodyText).toBe("auto reply");
  });

  it("caps the body at 200KB", () => {
    expect(parseGmailMessage(message(text("text/plain", "a".repeat(300_000)))).bodyText).toHaveLength(200_000);
  });
});

describe("parseGmailMessage cc", () => {
  const parse = (extra: Array<{ name: string; value: string }>) =>
    parseGmailMessage(message({ mimeType: "text/plain", headers: [...baseHeaders, ...extra], body: { data: b64("x") } }));

  it("reads Cc with display names, quoted commas and groups", () => {
    expect(parse([h("Cc", '"Park, Jo" <Jo@X.com>, Team: a@x.com, b@x.com;')]).cc).toEqual(["jo@x.com", "a@x.com", "b@x.com"]);
  });
  it("merges every Resent-Cc header and dedupes against Cc", () => {
    expect(parse([h("Cc", "a@x.com"), h("Resent-Cc", "A@x.com, b@x.com"), h("Resent-Cc", "c@x.com")]).cc).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });
  it("is empty without a Cc header", () => {
    expect(parse([]).cc).toEqual([]);
  });
  it("keeps quoted commas in To", () => {
    expect(parse([]).to).toEqual(["sam@acme.com", "other@acme.com"]);
  });
});
