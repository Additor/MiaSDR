import type postgres from "postgres";
import { createTestOrg, type TestOrg } from "@/test-support/db";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [
  { stepNumber: 1, kind: "email", subject: "Hi {{firstName}}", body: "Hello {{firstName}}", waitDays: 0 },
  { stepNumber: 2, kind: "email", subject: "", body: "Following up", waitDays: 2 },
];

export interface EmailSendSeed {
  org: string;
  userId: string;
  mailbox: string;
  campaign: string;
  person: string;
  enrollment: string;
}

/**
 * An organization with one connected all-day mailbox, an active two-step email campaign and one lead enrolled in it.
 * Pushes the org onto `orgs` so the caller's `dropOrgs` removes it with its owner.
 */
export async function seedEmailEnrollment(sql: postgres.Sql, orgs: TestOrg[]): Promise<EmailSendSeed> {
  const owner = await createTestOrg(sql, "R");
  orgs.push(owner);
  const { organizationId: org, userId, slug: tag } = owner;
  const [{ id: mailbox }] = await sql<{ id: string }[]>`
    insert into mailboxes (organization_id, email_address, display_name, status, daily_send_limit, working_hours)
    values (${org}, ${`s-${tag}@corp.test`}, 'S', 'connected', 30, ${sql.json({ timeZone: "UTC", days: ALL_DAY })}) returning id`;
  const [{ id: campaign }] = await sql<{ id: string }[]>`insert into campaigns (organization_id, channel, name, status, steps) values (${org}, 'email', 'c', 'active', ${sql.json(STEPS as never)}) returning id`;
  const [{ id: person }] = await sql<{ id: string }[]>`insert into people (organization_id, email, first_name, full_name) values (${org}, ${`l-${tag}@acme.test`}, 'Lee', 'Lee Doe') returning id`;
  const [{ id: enrollment }] = await sql<{ id: string }[]>`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${org}, ${campaign}, ${person}, 'email') returning id`;
  return { org, userId, mailbox, campaign, person, enrollment };
}
