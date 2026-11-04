import { errorText } from "@/shared/error-text";
import { isWithinWorkingHours } from "../../domain/working-hours";
import { INBOUND_READ_EVERY_MINUTES } from "../domain/linkedin";
import { receiveLinkedInWebhook } from "./linkedin-inbound";
import { LinkedInGatewayError, type LinkedInInboundPollDeps } from "./linkedin-ports";

export interface InboundPollReport {
  accounts: number;
  deliveries: number;
  failed: number;
  finished: number;
}

/**
 * Reads the inbox of accounts whose vendor sends no webhook for messages, oldest read first, inside each account's hours.
 * A read goes in steps of one API call. A step's deliveries go through the same ledger as a webhook's before the cursor
 * moves, so a stopped read carries on, and a repeat is a duplicate. `deadline` is this job's share of the tick.
 */
export async function pollLinkedInInbound(deps: LinkedInInboundPollDeps, deadline: number): Promise<InboundPollReport> {
  const report: InboundPollReport = { accounts: 0, deliveries: 0, failed: 0, finished: 0 };
  const now = deps.clock.now();
  const due = await deps.store.listDue(new Date(now.getTime() - INBOUND_READ_EVERY_MINUTES * 60_000));
  for (const account of due) {
    if (Date.now() >= deadline) break;
    if (!isWithinWorkingHours(now, account.workingHours)) continue;
    report.accounts += 1;
    let cursor = account.cursor;
    try {
      while (Date.now() < deadline) {
        const read = await deps.source.read({ organizationId: account.organizationId, account: account.providerAccountId, cursor, now: deps.clock.now() });
        for (const payload of read.deliveries) {
          await receiveLinkedInWebhook(deps.inbound, { organizationId: account.organizationId, provider: account.provider, payload });
          report.deliveries += 1;
        }
        await deps.store.saveCursor(account.id, read.cursor, read.finishedRunStartedAt);
        cursor = read.cursor;
        if (read.finishedRunStartedAt) {
          report.finished += 1;
          break;
        }
      }
    } catch (error) {
      // The cursor stays. Until a read finishes, a claim refuses this account, so nothing goes out on old news.
      report.failed += 1;
      if (error instanceof LinkedInGatewayError && error.kind === "definite" && error.code === "auth") await deps.store.disconnect(account.id, errorText(error));
    }
  }
  return report;
}
