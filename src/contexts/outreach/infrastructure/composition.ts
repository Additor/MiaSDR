import { readFileSync } from "node:fs";
import { env } from "@/shared/env";
import type { CampaignDeps } from "../application/campaign-management";
import type { EmailRulesDeps } from "../email/application/email-rules";
import type { SendPauseDeps } from "../application/send-pause";
import { auditSink } from "@/platform/db/audit";
import { parseAllowedDomains, type MailboxDeps, type MailboxDomainPolicy } from "../email/application/mailbox-management";
import type { MergeFieldSource } from "../application/merge-fields";
import { createEmailJobs } from "../email/application/email-jobs";
import type { FollowUpStop, InboxFiling } from "../application/inbound-ports";
import { createInboxJobs } from "../email/application/inbox-jobs";
import type { MailboxProvider } from "../application/ports";
import type { LeadActivityDeps } from "../application/read-lead-activity";
import type { EngineDeps } from "../email/application/send-next-email";
import { reconcileTestSends, type TestSendDeps } from "../email/application/send-test-email";
import type { SuppressionStore } from "../email/application/unsubscribe";
import type { SuppressionListDeps } from "../application/suppression-list";
import { drizzleChannelSettingsStore } from "./drizzle-channel-settings-store";
import { drizzleEnrollmentAdminStore } from "./drizzle-enrollment-admin";
import { createDrizzleInboundStore } from "../email/infrastructure/drizzle-inbound-store";
import { readLeadStatuses } from "./drizzle-lead-statuses";
import { drizzleMergeFieldSource } from "./drizzle-merge-fields";
import { drizzleOutreachStore } from "./drizzle-outreach-store";
import { createSuppressionStore } from "./suppression-store";
import { drizzleSuppressionListStore } from "./drizzle-suppression-list-store";
import { readReachability } from "./drizzle-reachability";
import { drizzleTestSendStore } from "../email/infrastructure/drizzle-test-send-store";
import { drizzleCampaignStore, drizzleMailboxStore } from "./drizzle-management-stores";
import { FakeMailboxProvider } from "../email/infrastructure/fake-mailbox-provider";
import { GmailMailboxProvider, parseServiceAccountJson } from "../email/infrastructure/gmail-mailbox-provider";
import { notConfiguredProvider } from "../email/infrastructure/not-configured-provider";

/** Reachability of a page of person ids (email, LinkedIn, do-not-contact, suppression). Pages call it directly. */
export { readReachability } from "./drizzle-reachability";

/** Enrollment admin store. Pages read the available senders from it. */
export { drizzleEnrollmentAdminStore as enrollmentAdminStore } from "./drizzle-enrollment-admin";

/** Enrolls people in an email campaign inside the caller's transaction (grid's campaign handoff). */
export { enrollEmailPeople } from "./drizzle-management-stores";

/** Cross-campaign notices reader. The notice use cases take it directly. */
export { drizzleCrossCampaignNotices as crossCampaignNotices } from "./drizzle-cross-campaign-notices";

const globalForFake = globalThis as unknown as { __miasdrFakeMailbox?: FakeMailboxProvider; __miasdrGmail?: GmailMailboxProvider };

/** One instance per process, so the per-mailbox token cache is shared. */
function gmailProvider(): GmailMailboxProvider {
  if (globalForFake.__miasdrGmail) return globalForFake.__miasdrGmail;
  const { GOOGLE_SERVICE_ACCOUNT_JSON: json, GOOGLE_SERVICE_ACCOUNT_FILE: file } = env();
  if (!json && !file) {
    throw new Error("MAILBOX_PROVIDER=gmail needs a service account key. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE.");
  }
  let raw = json;
  if (!raw && file) {
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      throw new Error(`Could not read the Google service account key file at ${file}. Check the path and that the file is mounted into the container.`);
    }
  }
  globalForFake.__miasdrGmail = new GmailMailboxProvider({ credentials: parseServiceAccountJson(raw as string) });
  return globalForFake.__miasdrGmail;
}

/** The one place that decides which mail adapter is live. */
export function mailboxProvider(): MailboxProvider {
  if (env().MAILBOX_PROVIDER === "fake") {
    globalForFake.__miasdrFakeMailbox ??= new FakeMailboxProvider();
    return globalForFake.__miasdrFakeMailbox;
  }
  if (env().MAILBOX_PROVIDER === "gmail") return gmailProvider();
  return notConfiguredProvider;
}

export const leadActivityDeps = (): LeadActivityDeps => ({ readStatuses: readLeadStatuses, readReach: readReachability });

/** The organization's email channel settings. */
export const emailRulesDeps = (): EmailRulesDeps => ({ settings: drizzleChannelSettingsStore });

/** The organization's sending pause, which writes an audit row on each change. */
export const sendPauseDeps = (): SendPauseDeps => ({ settings: drizzleChannelSettingsStore, audit: auditSink });

/** Merge fields offered in the sequence editor. */
export const mergeFieldDeps = (): { source: MergeFieldSource } => ({ source: drizzleMergeFieldSource });

/** Public unsubscribe link: the suppression store and the token secret. src/composition passes conversations' follow-up stop. */
export const unsubscribeDeps = (followUps: FollowUpStop): { store: SuppressionStore; secret: string } => ({ store: createSuppressionStore(followUps), secret: env().UNSUBSCRIBE_SECRET });

/** Settings, Suppression list: reads the list, and adds through the same suppression that ends follow-up sequences. */
export const suppressionListDeps = (followUps: FollowUpStop): SuppressionListDeps => ({ list: drizzleSuppressionListStore, suppress: createSuppressionStore(followUps) });

export const campaignDeps = (): CampaignDeps => ({ campaigns: drizzleCampaignStore, mailboxes: drizzleMailboxStore, admin: drizzleEnrollmentAdminStore });

function mailboxDomainPolicy(): MailboxDomainPolicy {
  return { allowedDomains: parseAllowedDomains(env().MAILBOX_ALLOWED_DOMAINS), openSignup: env().AUTH_SIGNUP === "open" };
}

export const mailboxDeps = (): MailboxDeps => ({ mailboxes: drizzleMailboxStore, provider: mailboxProvider(), now: () => new Date(), policy: mailboxDomainPolicy() });

export function testSendDeps(): TestSendDeps {
  return {
    store: drizzleTestSendStore,
    provider: mailboxProvider(),
    clock: { now: () => new Date() },
    appUrl: env().APP_URL,
    unsubscribeSecret: env().UNSUBSCRIBE_SECRET,
    domainPolicy: mailboxDomainPolicy(),
  };
}

function engineDeps(): EngineDeps {
  return {
    store: drizzleOutreachStore,
    provider: mailboxProvider(),
    clock: { now: () => new Date() },
    random: Math.random,
    appUrl: env().APP_URL,
    unsubscribeSecret: env().UNSUBSCRIBE_SECRET,
    domainPolicy: mailboxDomainPolicy(),
  };
}

/** Email jobs run only when an adapter is selected: Gmail, or the demo `fake` provider. */
export function emailJobs(inbox: InboxFiling, followUps: FollowUpStop) {
  const provider = env().MAILBOX_PROVIDER;
  if (provider !== "fake" && provider !== "gmail") return [];
  try {
    // Inbox sync first, so a reply stops its sequence before the send job looks for due follow-ups.
    return [
      ...createInboxJobs({ store: createDrizzleInboundStore(inbox, followUps), provider: mailboxProvider(), clock: { now: () => new Date() }, minIntervalSeconds: 60 }),
      ...createEmailJobs(engineDeps()),
      {
        name: "email.reconcile-test",
        async run() {
          const report = await reconcileTestSends(testSendDeps());
          return { processed: report.foundSent + report.notSent, more: report.checked >= 25, detail: { checked: report.checked, found_sent: report.foundSent, not_sent: report.notSent, waiting: report.waiting } };
        },
      },
    ];
  } catch (error) {
    // A missing or malformed key must not stop the app from booting; the mailbox page reports the same error.
    console.error(`Email jobs disabled: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
