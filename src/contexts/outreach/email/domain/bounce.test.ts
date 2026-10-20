import { describe, expect, it } from "vitest";
import { detectBounce, isAuthenticatedFrom, isGenuineDeliverySender, isVerifiedBounce } from "./bounce";

const DAEMON = "Mail Delivery Subsystem <mailer-daemon@googlemail.com>";

describe("detectBounce patterns", () => {
  it("parses Gmail 'wasn't delivered to'", () => {
    const result = detectBounce({
      from: DAEMON,
      subject: "Delivery Status Notification (Failure)",
      bodyText:
        "** Address not found **\n\nYour message wasn't delivered to jane@acme.com because the domain acme.com couldn't be found.\n\nThe response was: 550 5.1.2 Host not found",
    });
    expect(result).toEqual({ failedRecipient: "jane@acme.com", kind: "hard" });
  });

  it("parses Gmail 'problem delivering your message to'", () => {
    const result = detectBounce({
      from: DAEMON,
      subject: "Delivery Status Notification (Failure)",
      bodyText:
        "There was a problem delivering your message to bob@corp.io. See the technical details below.\n550 5.1.1 User unknown",
    });
    expect(result?.failedRecipient).toBe("bob@corp.io");
    expect(result?.kind).toBe("hard");
  });

  it("parses 'Your message to X couldn't be delivered'", () => {
    const result = detectBounce({
      from: "postmaster@outbound.example.net",
      subject: "Undeliverable: Quick question",
      bodyText:
        "Your message to sam@example.org couldn't be delivered.\nsam wasn't found at example.org.",
    });
    expect(result?.failedRecipient).toBe("sam@example.org");
  });

  it("parses 'Your message to X has been blocked'", () => {
    const result = detectBounce({
      from: "postmaster@outbound.example.net",
      subject: "Undeliverable: Hello",
      bodyText: "Your message to <lee@example.org> has been blocked. 550 5.7.1 rejected",
    });
    expect(result?.failedRecipient).toBe("lee@example.org");
  });

  it("parses Microsoft 'Recipient Address:'", () => {
    const result = detectBounce({
      from: "Microsoft Outlook <postmaster@contoso.onmicrosoft.com>",
      subject: "Undeliverable: Intro",
      bodyText:
        "Delivery has failed to these recipients or groups:\n\nRecipient Address: pat@contoso.com\nReason: 550 5.4.1 Recipient address rejected: Access denied",
    });
    expect(result).toEqual({ failedRecipient: "pat@contoso.com", kind: "hard" });
  });

  it("parses the Gmail list template 'address(es) failed:'", () => {
    const result = detectBounce({
      from: DAEMON,
      subject: "Delivery Status Notification (Failure)",
      bodyText:
        "Delivery to the following recipient failed permanently:\n\nThe following address(es) failed:\n\n  kim@lists.example.com\n    unknown user",
    });
    expect(result?.failedRecipient).toBe("kim@lists.example.com");
  });

  it("parses GoDaddy 'recipients failed permanently:'", () => {
    const result = detectBounce({
      from: "mailer-daemon@secureserver.net",
      subject: "Returned mail: see transcript for details",
      bodyText:
        "The following recipients failed permanently: ann@smallbiz.com\nRemote host said: 550 mailbox unavailable",
    });
    expect(result?.failedRecipient).toBe("ann@smallbiz.com");
  });

  it("parses RFC 3464 Final-Recipient in a delivery-status report", () => {
    const result = detectBounce({
      from: "someone@relay.example.com",
      subject: "Failure notice",
      headers: {
        "Content-Type": "multipart/report; report-type=delivery-status; boundary=abc",
      },
      bodyText:
        "Reporting-MTA: dns; relay.example.com\n\nFinal-Recipient: rfc822; dee@example.com\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 no such user",
    });
    expect(result).toEqual({ failedRecipient: "dee@example.com", kind: "hard" });
  });
});

describe("detectBounce classification and normalization", () => {
  it("classifies a 4.x.x status as soft", () => {
    const result = detectBounce({
      from: "mailer-daemon@example.com",
      subject: "Mail delivery failed: returning message to sender",
      bodyText:
        "Final-Recipient: rfc822; full@example.com\nAction: failed\nStatus: 4.2.2\nDiagnostic-Code: smtp; 452 4.2.2 mailbox full",
    });
    expect(result).toEqual({ failedRecipient: "full@example.com", kind: "soft" });
  });

  it("classifies 'try again later' text as soft", () => {
    const result = detectBounce({
      from: DAEMON,
      subject: "Delivery Status Notification (Failure)",
      bodyText:
        "Your message wasn't delivered to busy@example.com. The server is temporarily unavailable, try again later.",
    });
    expect(result?.kind).toBe("soft");
  });

  it("lowercases and trims the address", () => {
    const result = detectBounce({
      from: DAEMON,
      subject: "Delivery Status Notification (Failure)",
      bodyText: "Recipient Address:   Jane.Doe@ACME.COM  \nReason: 550 5.1.1",
    });
    expect(result?.failedRecipient).toBe("jane.doe@acme.com");
  });

  it("accepts an Auto-Submitted header with a failure subject", () => {
    const result = detectBounce({
      from: "noreply@relay.example.com",
      subject: "Undeliverable: hi",
      headers: { "auto-submitted": "auto-generated" },
      bodyText: "Recipient Address: z@example.com",
    });
    expect(result?.failedRecipient).toBe("z@example.com");
  });
});

describe("detectBounce rejections", () => {
  it("returns null for an out-of-office reply", () => {
    expect(
      detectBounce({
        from: "Jane Doe <jane@acme.com>",
        subject: "Out of office: Quick question",
        headers: { "Auto-Submitted": "auto-replied" },
        bodyText: "I am away until Monday with limited access to email.",
      }),
    ).toBeNull();
  });

  it("returns null when a human quotes 'wasn't delivered to'", () => {
    expect(
      detectBounce({
        from: "Jane Doe <jane@acme.com>",
        subject: "Re: Undeliverable: Quick question",
        bodyText:
          "Hi, I got a notice that your message wasn't delivered to old@acme.com. Please use this address instead.",
      }),
    ).toBeNull();
  });

  it("returns null for a delivery-system sender without a recipient", () => {
    expect(
      detectBounce({
        from: "mailer-daemon@example.com",
        subject: "Mail delivery failed",
        bodyText: "Something went wrong.",
      }),
    ).toBeNull();
  });

  it("returns null for a delay notice", () => {
    expect(
      detectBounce({
        from: DAEMON,
        subject: "Delivery Status Notification (Delay)",
        bodyText: "Your message wasn't delivered to slow@example.com yet. We will keep trying.",
      }),
    ).toBeNull();
  });
});

const GMAIL_AUTH =
  "mx.google.com; dkim=pass header.i=@googlemail.com header.s=20230601 header.b=AbCdEf12; spf=pass (google.com: domain of mailer-daemon@googlemail.com designates 209.85.220.69 as permitted sender) smtp.mailfrom=mailer-daemon@googlemail.com; dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=googlemail.com";
const authFor = (domain: string) =>
  `mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=x; spf=pass smtp.mailfrom=mailer-daemon@${domain}; dmarc=pass (p=NONE) header.from=${domain}`;

describe("isAuthenticatedFrom", () => {
  it("accepts Gmail's own notice", () => {
    expect(isAuthenticatedFrom(GMAIL_AUTH, "googlemail.com")).toBe(true);
  });

  it("rejects missing, empty and foreign-authserv headers", () => {
    expect(isAuthenticatedFrom(undefined, "example.com")).toBe(false);
    expect(isAuthenticatedFrom("", "example.com")).toBe(false);
    expect(isAuthenticatedFrom(authFor("example.com").replace("mx.google.com", "mx.evil.com"), "example.com")).toBe(false);
  });

  it("rejects when the passing domain differs from the claimed sender domain", () => {
    expect(isAuthenticatedFrom(authFor("evil.com"), "googlemail.com")).toBe(false);
  });

  it("rejects dmarc=fail even when dkim or spf pass", () => {
    const value = "mx.google.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=mailer-daemon@example.com; dmarc=fail (p=NONE) header.from=example.com";
    expect(isAuthenticatedFrom(value, "example.com")).toBe(false);
  });

  it("accepts dkim=pass alone with an aligned signing domain, and spf=pass alone with an aligned envelope", () => {
    expect(isAuthenticatedFrom("mx.google.com; dkim=pass header.d=mail.example.com header.s=a", "example.com")).toBe(true);
    expect(isAuthenticatedFrom("mx.google.com; spf=pass smtp.mailfrom=bounce@example.com", "example.com")).toBe(true);
    expect(isAuthenticatedFrom("mx.google.com; dkim=pass header.d=evil.com header.s=a", "example.com")).toBe(false);
    expect(isAuthenticatedFrom("mx.google.com; spf=softfail smtp.mailfrom=bounce@example.com", "example.com")).toBe(false);
  });

  it("does not let a result hidden in a comment count", () => {
    expect(isAuthenticatedFrom("mx.google.com; dmarc=fail (dmarc=pass header.from=example.com) header.from=example.com", "example.com")).toBe(false);
  });
});

describe("isVerifiedBounce", () => {
  const base = { mailboxAddress: "me@corp.test", failedRecipient: "ceo@customer.com", weSentToRecipient: true, tiedToOurSend: false };

  it("accepts an authenticated Google delivery notice for an address we mailed", () => {
    expect(isVerifiedBounce({ ...base, from: DAEMON, authenticationResults: GMAIL_AUTH })).toBe(true);
  });

  it("rejects an unauthenticated Google-looking notice", () => {
    expect(isVerifiedBounce({ ...base, from: DAEMON })).toBe(false);
    expect(isVerifiedBounce({ ...base, from: DAEMON, authenticationResults: authFor("evil.com") })).toBe(false);
  });

  it("rejects a forged mailer-daemon on the recipient's domain without authentication or with dmarc=fail", () => {
    const from = "mailer-daemon@customer.com";
    expect(isVerifiedBounce({ ...base, from })).toBe(false);
    expect(isVerifiedBounce({ ...base, from, authenticationResults: "mx.google.com; spf=fail smtp.mailfrom=customer.com; dmarc=fail header.from=customer.com" })).toBe(false);
  });

  it("accepts authenticated delivery-system mail from the recipient's own domain", () => {
    expect(isVerifiedBounce({ ...base, from: "mailer-daemon@customer.com", authenticationResults: authFor("customer.com") })).toBe(true);
  });

  it("ignores an Authentication-Results the sender injected (not a Google authserv-id)", () => {
    const injected = "mx.customer.com; dmarc=pass header.from=customer.com";
    expect(isVerifiedBounce({ ...base, from: "mailer-daemon@customer.com", authenticationResults: injected })).toBe(false);
  });

  it("rejects a spoofed display name on a foreign domain, even for an address we mailed", () => {
    expect(isVerifiedBounce({ ...base, from: "Mail Delivery Subsystem <x@evil.com>", authenticationResults: authFor("evil.com") })).toBe(false);
    expect(isVerifiedBounce({ ...base, from: "mailer-daemon@evil.com", authenticationResults: authFor("evil.com") })).toBe(false);
  });

  it("accepts a foreign sender when the message carries our send, without authentication", () => {
    expect(isVerifiedBounce({ ...base, from: "Mail Delivery Subsystem <x@evil.com>", tiedToOurSend: true })).toBe(true);
  });

  it("rejects everything for an address we never mailed", () => {
    expect(isVerifiedBounce({ ...base, from: DAEMON, authenticationResults: GMAIL_AUTH, weSentToRecipient: false, tiedToOurSend: true })).toBe(false);
  });

  it("trusts mailer-daemon on the recipient's or our own domain, not on a lookalike", () => {
    expect(isGenuineDeliverySender("mailer-daemon@mx.customer.com", "me@corp.test", "ceo@customer.com")).toBe(true);
    expect(isGenuineDeliverySender("postmaster@corp.test", "me@corp.test", "ceo@customer.com")).toBe(true);
    expect(isGenuineDeliverySender("mailer-daemon@customer.com.evil.com", "me@corp.test", "ceo@customer.com")).toBe(false);
    expect(isGenuineDeliverySender("mailer-daemon@notgoogle.com", "me@corp.test", "ceo@customer.com")).toBe(false);
  });
});
