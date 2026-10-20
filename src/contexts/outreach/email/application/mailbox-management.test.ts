import { describe, expect, it, vi } from "vitest";
import { ValidationError, type Actor } from "@/shared/errors";
import { connectMailbox, mailboxPolicyViolation, parseAllowedDomains, retestMailbox, type MailboxDeps, type MailboxDomainPolicy } from "./mailbox-management";

const actor: Actor = { userId: "u", organizationId: "o", role: "owner" };

function setup(policy: MailboxDomainPolicy, existing = "ceo@operator.com") {
  const setStatus = vi.fn(async () => undefined);
  const insert = vi.fn(async () => "m1");
  const verify = vi.fn(async () => undefined);
  const deps = {
    mailboxes: { insert, setStatus, get: async () => ({ id: "m1", emailAddress: existing, lastTestedAt: null }) },
    provider: { verify },
    now: () => new Date("2026-10-15T00:00:00Z"),
    policy,
  } as unknown as MailboxDeps;
  return { deps, setStatus, insert, verify };
}

describe("mailbox domain policy", () => {
  it("parses the env list", () => {
    expect(parseAllowedDomains(undefined)).toBeNull();
    expect(parseAllowedDomains(" , ")).toBeNull();
    expect(parseAllowedDomains(" Acme.com, @b.org ")).toEqual(["acme.com", "b.org"]);
  });

  it("allows only listed domains when a list is set", () => {
    const policy = { allowedDomains: ["acme.com"], openSignup: true };
    expect(mailboxPolicyViolation(policy, "a@ACME.com")).toBeNull();
    expect(mailboxPolicyViolation(policy, "a@evil.com")).toMatch(/not an allowed mailbox domain/);
    expect(mailboxPolicyViolation(policy, "a@sub.acme.com")).not.toBeNull();
  });

  it("without a list, allows invite-only and refuses open sign-up", () => {
    expect(mailboxPolicyViolation({ allowedDomains: null, openSignup: false }, "a@x.com")).toBeNull();
    expect(mailboxPolicyViolation({ allowedDomains: null, openSignup: true }, "a@x.com")).toMatch(/MAILBOX_ALLOWED_DOMAINS/);
  });

  it("connect rejects before storing or verifying", async () => {
    const t = setup({ allowedDomains: null, openSignup: true });
    await expect(connectMailbox(t.deps, actor, { emailAddress: "ceo@operator.com" })).rejects.toBeInstanceOf(ValidationError);
    expect(t.insert).not.toHaveBeenCalled();
    expect(t.verify).not.toHaveBeenCalled();
  });

  it("connect succeeds inside the list", async () => {
    const t = setup({ allowedDomains: ["operator.com"], openSignup: true });
    await connectMailbox(t.deps, actor, { emailAddress: "Sales@Operator.com" });
    expect(t.verify).toHaveBeenCalledOnce();
  });

  it("retest of a mailbox outside the list fails with the reason and never verifies", async () => {
    const t = setup({ allowedDomains: ["other.com"], openSignup: false });
    await retestMailbox(t.deps, actor, "m1");
    expect(t.verify).not.toHaveBeenCalled();
    expect(t.setStatus).toHaveBeenCalledWith("o", "m1", "failed", expect.stringMatching(/not an allowed mailbox domain/), expect.anything());
  });
});
