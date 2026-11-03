import { describe, expect, it, vi } from "vitest";
import { ValidationError, type Actor } from "@/shared/errors";
import { connectMailbox, mailboxPolicyViolation, parseAllowedDomains, retestMailbox, type MailboxDeps, type MailboxDomainPolicy } from "./mailbox-management";

const actor: Actor = { userId: "u", organizationId: "o", role: "owner" };

function setup(policy: MailboxDomainPolicy, existing = "ceo@operator.com", status = "connected") {
  const setStatus = vi.fn(async () => undefined);
  const insert = vi.fn(async () => "m1");
  const verify = vi.fn(async () => undefined);
  const deps = {
    mailboxes: { insert, setStatus, get: async () => ({ id: "m1", emailAddress: existing, status, lastTestedAt: null }) },
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
    const policy = { allowedDomains: ["acme.com"] };
    expect(mailboxPolicyViolation(policy, "a@ACME.com")).toBeNull();
    expect(mailboxPolicyViolation(policy, "a@evil.com")).toMatch(/not an allowed mailbox domain/);
    expect(mailboxPolicyViolation(policy, "a@sub.acme.com")).not.toBeNull();
  });

  it("without a list, allows any address", () => {
    expect(mailboxPolicyViolation({ allowedDomains: null }, "a@x.com")).toBeNull();
  });

  it("connect rejects before storing or verifying", async () => {
    const t = setup({ allowedDomains: ["other.com"] });
    await expect(connectMailbox(t.deps, actor, { emailAddress: "ceo@operator.com" })).rejects.toBeInstanceOf(ValidationError);
    expect(t.insert).not.toHaveBeenCalled();
    expect(t.verify).not.toHaveBeenCalled();
  });

  it("connect succeeds inside the list", async () => {
    const t = setup({ allowedDomains: ["operator.com"] });
    await connectMailbox(t.deps, actor, { emailAddress: "Sales@Operator.com" });
    expect(t.verify).toHaveBeenCalledOnce();
  });

  it("connect stores nothing for an address the provider refuses, and answers with the provider's reason", async () => {
    const t = setup({ allowedDomains: ["operator.com"] });
    t.verify.mockRejectedValueOnce(new Error("Gmail refused access"));
    await expect(connectMailbox(t.deps, actor, { emailAddress: "sales@operator.com" })).rejects.toThrow(ValidationError);
    expect(t.insert).not.toHaveBeenCalled();
  });

  it("retest of a mailbox outside the list fails with the reason and never verifies", async () => {
    const t = setup({ allowedDomains: ["other.com"] });
    await retestMailbox(t.deps, actor, "m1");
    expect(t.verify).not.toHaveBeenCalled();
    expect(t.setStatus).toHaveBeenCalledWith("o", "m1", "failed", expect.stringMatching(/not an allowed mailbox domain/), expect.anything(), ["connected", "failed"]);
  });

  it("Recheck leaves a disabled mailbox disabled and asks nobody", async () => {
    const t = setup({ allowedDomains: null }, "ceo@operator.com", "disabled");
    await expect(retestMailbox(t.deps, actor, "m1")).rejects.toThrow(/Enable it/);
    expect(t.verify).not.toHaveBeenCalled();
    expect(t.setStatus).not.toHaveBeenCalled();
  });
});
