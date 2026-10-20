import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@/shared/errors";
import { sendTestEmail, type TestSendDeps } from "./send-test-email";

const original = process.env.PAUSE_OUTBOUND;
afterEach(() => {
  if (original === undefined) delete process.env.PAUSE_OUTBOUND;
  else process.env.PAUSE_OUTBOUND = original;
});

function deps() {
  const claim = vi.fn(async () => ({ kind: "not_found" as const }));
  const send = vi.fn();
  const value = {
    store: { claim },
    provider: { send },
    clock: { now: () => new Date("2026-10-15T10:00:00Z") },
    appUrl: "https://app.test",
    unsubscribeSecret: "u".repeat(40),
    domainPolicy: { allowedDomains: null, openSignup: false },
  } as unknown as TestSendDeps;
  return { value, claim, send };
}

const actor = { userId: "u1", organizationId: "o1", role: "admin" };

describe("sendTestEmail pause", () => {
  it("refuses with a conflict before any claim or provider call while paused", async () => {
    process.env.PAUSE_OUTBOUND = "true";
    const d = deps();
    const error = await sendTestEmail(d.value, actor, "m1", { to: "dev@example.com" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe("Sending is paused, so no test email was sent. The server administrator ends the pause, see docs/operations.md.");
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("also refuses for an unreadable PAUSE_OUTBOUND", async () => {
    process.env.PAUSE_OUTBOUND = "ture";
    const d = deps();
    await expect(sendTestEmail(d.value, actor, "m1", { to: "dev@example.com" })).rejects.toBeInstanceOf(ConflictError);
    expect(d.claim).not.toHaveBeenCalled();
  });

  it("proceeds to the claim when not paused", async () => {
    delete process.env.PAUSE_OUTBOUND;
    const d = deps();
    await expect(sendTestEmail(d.value, actor, "m1", { to: "dev@example.com" })).rejects.toThrow(/Mailbox not found/);
    expect(d.claim).toHaveBeenCalledTimes(1);
  });
});
