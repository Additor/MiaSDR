import { readFileSync } from "node:fs";
import postgres from "postgres";
import { expect, test as base, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";

export const ADMIN = { name: "Ada Admin", email: "ada@e2e-corp.test", password: "correct-horse-1", organization: "E2E Corp" };

export function cronSecret(): string {
  return process.env.E2E_CRON_SECRET ?? "";
}

/**
 * Every test fails on a console error, an uncaught page error or a failed request (network failure or
 * status 400 and up). A test that provokes one on purpose declares it with `tolerate`.
 */
interface Watch {
  /** Allow responses or console errors whose text matches. Call before the action that triggers them. */
  tolerate: (...patterns: RegExp[]) => void;
}

let rateLimitFile = "";

export const test = base.extend<{ watch: Watch; freshRateLimits: void }>({
  /**
   * Better Auth limits sign-in to 3 requests per 10 seconds, and the server counts every spec file's requests.
   * The first test of each file clears the counters (and the local bookkeeping in `signInTimes`), so a file
   * behaves the same alone, in a partial run or after the earlier files.
   */
  freshRateLimits: [
    async ({ request }, use, testInfo) => {
      if (testInfo.file !== rateLimitFile) {
        const res = await request.post("/api/webhooks/dev-fakes", { headers: { authorization: `Bearer ${cronSecret()}` }, data: { action: "resetRateLimits" } });
        expect(res.status(), "reset rate limits").toBe(200);
        expect((await res.json()).ok, "the rate-limit store is resettable (E2E build)").toBe(true);
        signInTimes.length = 0;
        rateLimitFile = testInfo.file;
      }
      await use();
    },
    { auto: true },
  ],
  watch: [
    async ({ page }, use) => {
      const problems: string[] = [];
      const allowed: RegExp[] = [];
      const record = (text: string) => {
        if (!allowed.some((re) => re.test(text))) problems.push(text);
      };
      page.on("console", (m) => {
        if (m.type() === "error") record(`console.error: ${m.text()} (${m.location().url})`);
      });
      page.on("pageerror", (e) => record(`pageerror: ${e.message}`));
      page.on("requestfailed", (r) => {
        const reason = r.failure()?.errorText ?? "";
        // A navigation or a newer fetch cancels a prefetch. That is not a failure of the app.
        if (reason === "net::ERR_ABORTED") return;
        record(`requestfailed: ${r.method()} ${r.url()} ${reason}`);
      });
      page.on("response", (r) => {
        if (r.status() >= 400) record(`response ${r.status()}: ${r.request().method()} ${r.url()}`);
      });
      await use({ tolerate: (...p) => allowed.push(...p) });
      expect(problems, "console errors and failed requests").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** Creates the first admin through the API when the instance is still empty. 409 means it exists. */
export async function ensureSetup(request: APIRequestContext): Promise<void> {
  const res = await request.post("/api/setup", {
    data: { name: ADMIN.name, email: ADMIN.email, password: ADMIN.password, organizationName: ADMIN.organization, timeZone: "UTC" },
  });
  expect([201, 409]).toContain(res.status());
}

const signInTimes: number[] = [];

/** Call before a flow that signs in through the UI `count` times. Waits until the rate-limit window has room. */
export async function makeRoomForSignIns(page: Page, count: number): Promise<void> {
  const now = Date.now();
  const recent = signInTimes.filter((t) => now - t < 10_500);
  if (recent.length + count > 3) await page.waitForTimeout(Math.max(...recent) + 10_500 - now);
  for (let i = 0; i < count; i++) signInTimes.push(Date.now());
}

const sessionCache = new Map<string, Awaited<ReturnType<BrowserContext["cookies"]>>>();

/**
 * Signs in through the auth API so the page context carries the session cookie. Better Auth limits sign-in to
 * 3 requests per 10 seconds, so a session is reused within the worker and a 429 waits for the window to pass.
 */
export async function signInAs(page: Page, email = ADMIN.email, password = ADMIN.password): Promise<void> {
  const cached = sessionCache.get(email);
  if (cached) {
    await page.context().addCookies(cached);
    const check = await page.request.get("/api/auth/get-session");
    if (check.ok() && (await check.json())?.user?.email === email) return;
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    await makeRoomForSignIns(page, 1);
    const res = await page.request.post("/api/auth/sign-in/email", { data: { email, password } });
    if (res.status() === 429) {
      await page.waitForTimeout(Number(res.headers()["x-retry-after"] ?? 10) * 1000 + 250);
      continue;
    }
    expect(res.status(), `sign-in as ${email}`).toBe(200);
    sessionCache.set(email, await page.context().cookies());
    return;
  }
  throw new Error(`sign-in as ${email} stayed rate limited`);
}

export async function signInAdmin(page: Page): Promise<void> {
  await ensureSetup(page.request);
  await signInAs(page);
}

/** Runs every registered job once (the embedded scheduler is off in the test server). */
export async function tick(request: APIRequestContext, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    const res = await request.post("/api/jobs/tick", { headers: { authorization: `Bearer ${cronSecret()}` } });
    expect(res.status(), "job tick").toBe(200);
  }
}

export async function devFakes<T = unknown>(request: APIRequestContext, body: Record<string, unknown>): Promise<T> {
  const res = await request.post("/api/webhooks/dev-fakes", { headers: { authorization: `Bearer ${cronSecret()}` }, data: body });
  expect(res.status(), `dev-fakes ${String(body.action)}`).toBe(200);
  return (await res.json()) as T;
}

/**
 * Auth emails go to the server log when no email service is configured. Returns the link of the newest
 * message sent to `to` whose subject contains `subject`.
 */
export function emailLink(to: string, subject: string): string | null {
  const log = readFileSync(process.env.E2E_SERVER_LOG ?? "", "utf8");
  const blocks = log.split("[auth-email] ").slice(1).reverse();
  for (const block of blocks) {
    if (!block.startsWith(`to=${to} `) || !block.split("\n")[0].includes(subject)) continue;
    const m = /: (https?:\/\/\S+)/.exec(block);
    if (m) return m[1];
  }
  return null;
}

export async function waitForEmailLink(to: string, subject: string): Promise<string> {
  let link: string | null = null;
  await expect.poll(() => (link = emailLink(to, subject)), { message: `email "${subject}" to ${to}`, timeout: 15_000 }).not.toBeNull();
  return link as unknown as string;
}

export const MOBILE_DARK = { viewport: { width: 390, height: 844 }, colorScheme: "dark" as const };

/** The page must not scroll sideways at phone width. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  // A fallback font can be wider than the web font, so measure once the web fonts have loaded.
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
}

/** Link-styled buttons (`Button render={<Link/>}`) expose role "button" today. Accept either role. */
export function linkOrButton(page: Page, name: string | RegExp) {
  return page.getByRole("link", { name }).or(page.getByRole("button", { name }));
}

export type CampaignTab = "leads" | "sequence" | "settings";

/**
 * Switches the campaign page to one of its tabs through the tab links (`?tab=leads|sequence|settings`, Leads is the bare URL).
 * Steps and "Save steps" are on Sequence. Senders, "Save senders" and the After a reply card are on Settings.
 */
export async function openCampaignTab(page: Page, tab: CampaignTab): Promise<void> {
  const link = page.getByTestId(`campaign-tab-${tab}`);
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
}

/**
 * Opens the add panel of the Leads tab. The "Add leads" toggle starts pressed only on a campaign with no leads, so the helper
 * presses it only when it is closed. Call it on the Leads tab.
 */
export async function openAddLeads(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Add leads", exact: true });
  await waitForHydrated(toggle);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#add-leads-panel")).toBeVisible();
}

/** The "After a reply" card on the Settings tab of a campaign. */
export function afterReplySettings(page: Page): Locator {
  return page.locator("#after-reply");
}

/** The "After a reply" card in the side column of an Inbox thread (run status, Pause follow-ups, Skip step, Stop follow-ups, Restart follow-ups). */
export function threadAfterReply(page: Page): Locator {
  return page.locator("#main-content").getByTestId("thread-after-reply");
}

/**
 * Turns on "AI drafts follow-ups for my approval" in the Settings tab of a campaign: step 1 (the reply) with a goal, one follow-up
 * with a goal and a wait, then Save, which stores and publishes in one step. Leaves the page on the Settings tab.
 */
export async function enableAiFollowUps(
  page: Page,
  campaignId: string,
  opts: { replyGoal?: string; followUpGoal?: string; wait?: number; unit?: "Minutes" | "Hours" | "Days" } = {},
): Promise<void> {
  const { replyGoal = "Answer their question and offer a short call.", followUpGoal = "Check in once and offer two meeting times.", wait = 2, unit = "Hours" } = opts;
  await page.goto(`/campaigns/${campaignId}?tab=settings`);
  const card = afterReplySettings(page);
  const ai = card.getByRole("radio", { name: /AI drafts follow-ups for my approval/ });
  await waitForHydrated(ai);
  await ai.check();
  await card.getByLabel("Goal").first().fill(replyGoal);
  await card.getByRole("button", { name: "Add follow-up" }).click();
  await card.getByLabel("Goal").nth(1).fill(followUpGoal);
  await card.getByLabel("Wait after the previous message").fill(String(wait));
  await card.getByRole("combobox", { name: "Unit for step 2" }).click();
  await page.getByRole("option", { name: unit, exact: true }).click();
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. New replies use these follow-ups.")).toBeVisible();
  await expect(ai).toBeChecked();
}

/** The inline `role="alert"` message that contains `text`. Next's empty route announcer also has role "alert", so a bare lookup matches two elements. */
export function alertWith(page: Page, text: string | RegExp) {
  return page.getByRole("alert").filter({ hasText: text });
}

const ALL_DAYS = Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, [{ start: "00:00", end: "23:59" }]]));

/** Connects a fake mailbox (once) and opens its sending hours around the clock, so a test never waits for 09:00. Returns its id. */
export async function ensureMailbox(request: APIRequestContext, emailAddress: string, displayName = "E2E Sender"): Promise<string> {
  const listed = await request.get("/api/mailboxes");
  expect(listed.status()).toBe(200);
  let box = ((await listed.json()) as Array<{ id: string; emailAddress: string }>).find((m) => m.emailAddress === emailAddress);
  if (!box) {
    const created = await request.post("/api/mailboxes", { data: { emailAddress, displayName } });
    expect(created.status(), `connect ${emailAddress}`).toBe(201);
    box = (await created.json()) as { id: string; emailAddress: string };
  }
  const patched = await request.patch(`/api/mailboxes/${box.id}`, { data: { dailySendLimit: 100, workingHours: { timeZone: "UTC", days: ALL_DAYS } } });
  expect(patched.status(), "open working hours").toBe(200);
  return box.id;
}

/** A CSV upload for the import wizard. */
export function csvFile(name: string, rows: string[][]) {
  return { name, mimeType: "text/csv", buffer: Buffer.from(rows.map((r) => r.join(",")).join("\n")) };
}

/** Imports leads through the API. Columns are mapped by header name: Email, First Name, Last Name, Job Title, Company. */
export async function importLeads(request: APIRequestContext, rows: Array<{ email: string; firstName: string; lastName: string; title?: string; company?: string }>): Promise<void> {
  const header = ["Email", "First Name", "Last Name", "Job Title", "Company"];
  const mapping = { Email: "email", "First Name": "first_name", "Last Name": "last_name", "Job Title": "title", Company: "company_name" };
  const body = [header, ...rows.map((r) => [r.email, r.firstName, r.lastName, r.title ?? "", r.company ?? ""])].map((r) => r.join(",")).join("\n");
  const res = await request.post("/api/leads/import", {
    multipart: { file: { name: "leads.csv", mimeType: "text/csv", buffer: Buffer.from(body) }, mapping: JSON.stringify(mapping), defaultCountry: "" },
  });
  expect(res.status(), "lead import").toBe(200);
}

/** Messages the fake mailbox has "sent" so far, oldest first. */
export interface Delivered {
  mailbox: { emailAddress: string; displayName: string | null };
  to: string;
  subject: string;
  bodyText: string;
  rfcMessageId: string;
  inReplyTo: string | null;
  cc?: string[];
}

export async function delivered(request: APIRequestContext): Promise<Delivered[]> {
  return devFakes<Delivered[]>(request, { action: "delivered" });
}

/** Puts an email in a fake inbox through the session-protected helper route. */
export async function deliverInbound(
  request: APIRequestContext,
  mail: { mailbox: string; fromEmail: string; fromName?: string; subject?: string; bodyText?: string; inReplyTo?: string | null; cc?: string[] },
): Promise<void> {
  const res = await request.post("/api/dev/inbound", { data: mail });
  expect(res.status(), "dev inbound").toBe(200);
}

let sqlClient: ReturnType<typeof postgres> | undefined;

/** Direct database access for test setup that the product has no control for (moving a clock-based schedule). */
export function sql(): ReturnType<typeof postgres> {
  sqlClient ??= postgres(process.env.E2E_DATABASE_URL ?? "", { max: 1 });
  return sqlClient;
}

/** The inbox sync waits 60 seconds between runs per mailbox. Backdate the last run so the next tick syncs. */
export async function makeInboxSyncDue(): Promise<void> {
  await sql()`update mailboxes set last_synced_at = now() - interval '10 minutes' where last_synced_at is not null`;
}

export interface SeedLead {
  email: string;
  firstName: string;
  lastName: string;
  title?: string;
  company?: string;
}

/**
 * Sends one campaign email to a new lead from a fresh mailbox and files the lead's reply in the inbox.
 * Everything runs through the API; the scenario that calls it tests the screens that come after.
 * Returns the id of the campaign and what the mailbox sent. The campaign hands replies to the Inbox unless `beforeReply` changes that.
 */
export async function seedReply(
  request: APIRequestContext,
  input: {
    key: string;
    mailbox: string;
    lead: SeedLead;
    reply: { subject?: string; bodyText: string; cc?: string[] };
    /** Runs once the campaign has emailed the lead and before the reply arrives, for example to set the campaign's After a reply mode. */
    beforeReply?: (campaignId: string) => Promise<void>;
  },
): Promise<{ campaignId: string; sent: Delivered }> {
  await ensureMailbox(request, input.mailbox, `Sender ${input.key}`);
  await tick(request); // first inbox sync records the mailbox position
  await importLeads(request, [input.lead]);
  const created = await request.post("/api/campaigns", { data: { name: `${input.key} campaign` } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const steps = await request.patch(`/api/campaigns/${id}`, {
    data: {
      steps: [
        { stepNumber: 1, kind: "email", subject: `Hello from ${input.key}`, body: "Hi {{firstName}}, can we talk this week?", waitDays: 0 },
        { stepNumber: 2, kind: "email", subject: "", body: "Following up, {{firstName}}.", waitDays: 3 },
      ],
    },
  });
  expect(steps.status(), "save steps").toBe(200);
  const enrolled = await request.post(`/api/campaigns/${id}/enroll`, { data: { query: input.lead.email } });
  expect(enrolled.status()).toBe(200);
  const started = await request.post(`/api/campaigns/${id}/status`, { data: { status: "active" } });
  expect(started.status(), "start").toBe(200);

  let sent: Delivered | undefined;
  await expect
    .poll(async () => {
      await tick(request);
      sent = (await delivered(request)).find((m) => m.to === input.lead.email);
      return Boolean(sent);
    }, { message: "campaign email sent" })
    .toBe(true);
  await input.beforeReply?.(id);
  await deliverInbound(request, {
    mailbox: sent!.mailbox.emailAddress,
    fromEmail: input.lead.email,
    fromName: `${input.lead.firstName} ${input.lead.lastName}`,
    subject: input.reply.subject ?? `Re: ${sent!.subject}`,
    bodyText: input.reply.bodyText,
    inReplyTo: sent!.rfcMessageId,
    ...(input.reply.cc ? { cc: input.reply.cc } : {}),
  });
  await makeInboxSyncDue();
  await tick(request, 3);
  return { campaignId: id, sent: sent! };
}

/**
 * The id of the organization the admin created at setup: the first one the admin owns. Spec 18 renames it and spec 24
 * adds a second one, so the lookup goes through the owner's membership and never through the name.
 */
export async function e2eOrganizationId(): Promise<string> {
  const [org] = await sql()`
    select o.id from organizations o
    join members m on m.organization_id = o.id
    join users u on u.id = m.user_id
    where u.email = ${ADMIN.email} and m.role like '%owner%'
    order by o.created_at asc limit 1`;
  expect(org, "the E2E organization exists").toBeTruthy();
  return org.id as string;
}

export interface Member {
  name: string;
  email: string;
  password: string;
}

/**
 * Adds a confirmed member to the E2E organization through the dev-fakes helper, so a spec that needs a second person
 * does not depend on the invite and reset flows of specs 02 and 03. Use an email of its own per spec file.
 */
export async function seedMember(request: APIRequestContext, member: Member): Promise<Member> {
  await ensureSetup(request);
  const organizationId = await e2eOrganizationId();
  await devFakes(request, { action: "seedMember", ...member, organizationId });
  return member;
}

export interface SeededContact {
  personId: string;
  deals: { open: string[]; won: string[]; lost: string[] };
}

/**
 * Adds a contact through Add contact (`POST /api/contacts`), so it starts with its "Added as a contact" history line. `history`
 * adds what the contact delete dialog counts: notes and tasks through their routes, and deals by title. Won and lost deals
 * close through the stage route; an open deal blocks the delete. Use a fresh email per run: a contact with history stays.
 */
export async function seedContact(
  request: APIRequestContext,
  input: {
    firstName: string;
    lastName: string;
    email: string;
    companyDomain?: string;
    companyName?: string;
    history?: { notes?: number; tasks?: number; open?: string[]; won?: string[]; lost?: string[] };
  },
): Promise<SeededContact> {
  const { history, ...contact } = input;
  const added = await request.post("/api/contacts", { data: { ...contact, idempotencyKey: unique("seed-contact") } });
  expect(added.status(), `add contact ${input.email}`).toBe(201);
  const { personId } = (await added.json()) as { personId: string };
  for (let i = 1; i <= (history?.notes ?? 0); i++) {
    const res = await request.post(`/api/people/${personId}/notes`, { data: { body: `Seed note ${i}` } });
    expect(res.status(), "seed note").toBe(201);
  }
  for (let i = 1; i <= (history?.tasks ?? 0); i++) {
    const res = await request.post(`/api/people/${personId}/tasks`, { data: { name: `Seed task ${i}` } });
    expect(res.status(), "seed task").toBe(201);
  }
  const deals: SeededContact["deals"] = { open: [], won: [], lost: [] };
  for (const kind of ["open", "won", "lost"] as const) {
    for (const title of history?.[kind] ?? []) {
      const res = await request.post("/api/deals", { data: { personId, title, idempotencyKey: unique("seed-deal") } });
      expect(res.status(), `seed deal ${title}`).toBe(201);
      const { dealId } = (await res.json()) as { dealId: string };
      if (kind !== "open") await closeDeal(request, dealId, kind);
      deals[kind].push(dealId);
    }
  }
  return { personId, deals };
}

/** Moves a deal to the first won or lost stage of the pipeline. A lost deal needs a reason. */
async function closeDeal(request: APIRequestContext, dealId: string, kind: "won" | "lost"): Promise<void> {
  const { stages } = (await (await request.get("/api/deal-stages")).json()) as { stages: Array<{ id: string | null; kind: string }> };
  const stage = stages.find((s) => s.kind === kind);
  expect(stage?.id, `a ${kind} stage`).toBeTruthy();
  const deal = (await (await request.get(`/api/deals/${dealId}`)).json()) as { version: number };
  const res = await request.post(`/api/deals/${dealId}/stage`, {
    data: { stageId: stage!.id, expectedVersion: deal.version, lostReason: kind === "lost" ? "Seeded as lost" : null },
  });
  expect(res.status(), `mark the deal ${kind}`).toBe(200);
}

/**
 * A company with leads only, as an import leaves it: not listed in Companies (`crm_listed_at` null, no contact). Seeds the
 * company and its leads directly and returns the company id. Use a fresh domain per run: Add company or a merge lists it.
 */
export async function seedUnlistedCompany(input: { domain: string; name: string; leads: Array<{ email: string; fullName: string }> }): Promise<string> {
  const db = sql();
  const orgId = await e2eOrganizationId();
  await db`insert into companies (organization_id, domain, name, source) values (${orgId}, ${input.domain}, ${input.name}, 'manual') on conflict do nothing`;
  const [company] = await db`select id from companies where organization_id = ${orgId} and domain = ${input.domain}`;
  for (const lead of input.leads) {
    await db`
      insert into people (organization_id, email, full_name, company_id, source)
      values (${orgId}, ${lead.email}, ${lead.fullName}, ${company.id}, 'manual')
      on conflict do nothing`;
  }
  return company.id as string;
}

/**
 * Gives the company at `companyDomain` another domain, as a merge leaves it (the Details row "Other domains"). `mergedName` is
 * the name of the company the merge removed. The alias must not be a company domain: a guard trigger refuses it.
 */
export async function seedCompanyAlias(input: { companyDomain: string; alias: string; mergedName?: string }): Promise<void> {
  const db = sql();
  const orgId = await e2eOrganizationId();
  const [company] = await db`select id from companies where organization_id = ${orgId} and domain = ${input.companyDomain}`;
  expect(company, `a company at ${input.companyDomain}`).toBeTruthy();
  await db`
    insert into company_domain_aliases (organization_id, company_id, domain, merged_name)
    values (${orgId}, ${company.id}, ${input.alias}, ${input.mergedName ?? null})
    on conflict do nothing`;
}

/**
 * Drops the session. Leaves the app first: with the shell still open, the sidebar prefetches protected links
 * after the cookie is gone, and the server answers those prefetches of /sign-in with 404 (a console error).
 */
export async function signOut(page: Page): Promise<void> {
  await page.goto("about:blank");
  await page.context().clearCookies();
}

/**
 * Waits until React has attached its handlers to the element. Server-rendered inputs show up before
 * hydration, and a change event fired earlier (setInputFiles) is lost because no onChange exists yet.
 */
export async function waitForHydrated(locator: Locator): Promise<void> {
  await locator.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        const ready = () => Object.keys(el).some((k) => k.startsWith("__reactProps$"));
        if (ready()) return resolve();
        const timer = setInterval(() => {
          if (ready()) {
            clearInterval(timer);
            resolve();
          }
        }, 50);
      }),
  );
}
