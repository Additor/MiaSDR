import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/platform/jobs/types";
import { createEmailJobs } from "../email/application/email-jobs";
import { createLinkedInJobs } from "../linkedin/application/linkedin-jobs";

const original = process.env.PAUSE_OUTBOUND;
afterEach(() => {
  if (original === undefined) delete process.env.PAUSE_OUTBOUND;
  else process.env.PAUSE_OUTBOUND = original;
});

const ctx = () => ({ deadline: Date.now() + 60_000, now: () => new Date() });
const job = (jobs: Job[], name: string) => jobs.find((j) => j.name === name) as Job;

describe("queue build under PAUSE_OUTBOUND", () => {
  function emailSetup() {
    const listSendableMailboxIds = vi.fn(async () => ({ ids: [], blockedByDomainPolicy: 0 }));
    const jobs = createEmailJobs({ store: { listSendableMailboxIds } } as never);
    return { listSendableMailboxIds, send: job(jobs, "email.send") };
  }

  function linkedinSetup() {
    const listActionableAccounts = vi.fn(async () => []);
    const jobs = createLinkedInJobs({ store: { listActionableAccounts } } as never, {} as never, {} as never, {} as never, {} as never);
    return { listActionableAccounts, run: job(jobs, "linkedin.run") };
  }

  it("email.send lists no mailboxes and reports paused while the switch is set", async () => {
    process.env.PAUSE_OUTBOUND = "true";
    const { listSendableMailboxIds, send } = emailSetup();
    expect(await send.run(ctx())).toEqual({ processed: 0, more: false, detail: { paused: 1 } });
    expect(listSendableMailboxIds).not.toHaveBeenCalled();
  });

  it("email.send lists mailboxes again once the switch is unset", async () => {
    delete process.env.PAUSE_OUTBOUND;
    const { listSendableMailboxIds, send } = emailSetup();
    const result = await send.run(ctx());
    expect(listSendableMailboxIds).toHaveBeenCalledTimes(1);
    expect(result.detail).not.toHaveProperty("paused");
  });

  it("linkedin.run lists no accounts and reports paused while the switch is set", async () => {
    process.env.PAUSE_OUTBOUND = "1";
    const { listActionableAccounts, run } = linkedinSetup();
    expect(await run.run(ctx())).toEqual({ processed: 0, more: false, detail: { paused: 1 } });
    expect(listActionableAccounts).not.toHaveBeenCalled();
  });

  it("linkedin.run lists accounts again once the switch is unset", async () => {
    process.env.PAUSE_OUTBOUND = "off";
    const { listActionableAccounts, run } = linkedinSetup();
    await run.run(ctx());
    expect(listActionableAccounts).toHaveBeenCalledTimes(1);
  });
});
