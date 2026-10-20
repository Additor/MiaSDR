import { describe, expect, it, vi } from "vitest";
import { createEmailJobs } from "./email-jobs";
import type { EngineDeps } from "./send-next-email";

describe("email.send job", () => {
  it("reports blocked mailboxes and logs the reason once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const listSendableMailboxIds = vi.fn(async () => ({ ids: [], blockedByDomainPolicy: 2 }));
    const deps = { store: { listSendableMailboxIds }, domainPolicy: { allowedDomains: null, openSignup: true } } as unknown as EngineDeps;
    const job = createEmailJobs(deps).find((j) => j.name === "email.send")!;
    const result = await job.run({ now: () => new Date(), deadline: Date.now() + 1000 } as never);
    expect(result.detail).toEqual({ blocked_by_domain_policy: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/AUTH_SIGNUP=open without MAILBOX_ALLOWED_DOMAINS/);
    expect(listSendableMailboxIds).toHaveBeenCalledWith(expect.any(Date), { allowedDomains: null, openSignup: true });
    warn.mockRestore();
  });
});
