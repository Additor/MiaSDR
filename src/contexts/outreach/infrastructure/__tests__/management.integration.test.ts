import { drizzleEnrollmentAdminStore } from "../drizzle-enrollment-admin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, type TestOrg, testSql, useTestEnv } from "@/test-support/db";
import { FakeMailboxProvider } from "../../email/infrastructure/fake-mailbox-provider";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("campaign and mailbox management", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let campaignsUc: typeof import("../../application/campaign-management");
  let mailboxUc: typeof import("../../email/application/mailbox-management");
  let stores: typeof import("../drizzle-management-stores");
  const orgs: TestOrg[] = [];
  const provider = new FakeMailboxProvider();

  async function org(role = "owner"): Promise<{ actor: Actor; member: Actor; campaignDeps: import("../../application/campaign-management").CampaignDeps; mailboxDeps: import("../../email/application/mailbox-management").MailboxDeps }> {
    const created = await createTestOrg(sql, "M");
    orgs.push(created);
    const { organizationId: id, userId } = created;
    return {
      actor: { userId, organizationId: id, role },
      member: { userId, organizationId: id, role: "member" },
      campaignDeps: { campaigns: stores.drizzleCampaignStore, mailboxes: stores.drizzleMailboxStore, admin: drizzleEnrollmentAdminStore },
      mailboxDeps: { mailboxes: stores.drizzleMailboxStore, provider, now: () => new Date("2026-10-14T10:00:00Z"), policy: { allowedDomains: null, openSignup: false } },
    };
  }

  const addPerson = async (orgId: string, email: string | null, first = "Pat", extra: Record<string, unknown> = {}) => {
    const [{ id }] = await sql`insert into people (organization_id, email, first_name, full_name, custom) values (${orgId}, ${email}, ${first}, ${first + " Test"}, ${sql.json(extra as never)}) returning id`;
    return id as string;
  };

  beforeAll(async () => {
    campaignsUc = await import("../../application/campaign-management");
    mailboxUc = await import("../../email/application/mailbox-management");
    stores = await import("../drizzle-management-stores");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("mailboxes", () => {
    it("lets only an owner or admin connect, and verifies through the provider", async () => {
      const t = await org();
      await expect(mailboxUc.connectMailbox(t.mailboxDeps, t.member, { emailAddress: "a@corp.test" })).rejects.toBeInstanceOf(ForbiddenError);
      const { id } = await mailboxUc.connectMailbox(t.mailboxDeps, { ...t.actor, role: "admin" }, { emailAddress: ` Sales${Math.random().toString(36).slice(2, 6)}@Corp.test `, displayName: " Ada " });
      const [mailbox] = await mailboxUc.listMailboxes(t.mailboxDeps, t.member); // any member may look
      expect(mailbox).toMatchObject({ id, status: "connected", displayName: "Ada", lastError: null });
      expect(mailbox.emailAddress).toBe(mailbox.emailAddress.toLowerCase());
    });

    it("records why a mailbox could not be verified and lets it be retested", async () => {
      const t = await org();
      const address = `blocked${Math.random().toString(36).slice(2, 6)}@corp.test`;
      provider.unverifiable.add(address);
      const { id } = await mailboxUc.connectMailbox(t.mailboxDeps, t.actor, { emailAddress: address });
      expect((await stores.drizzleMailboxStore.get(t.actor.organizationId, id))).toMatchObject({ status: "failed", lastError: expect.stringMatching(/not allowed/) });
      provider.unverifiable.delete(address);
      await mailboxUc.retestMailbox(t.mailboxDeps, t.actor, id);
      expect((await stores.drizzleMailboxStore.get(t.actor.organizationId, id))?.status).toBe("connected");
    });

    it("rejects bad addresses and addresses connected anywhere else", async () => {
      const t = await org();
      const u = await org();
      await expect(mailboxUc.connectMailbox(t.mailboxDeps, t.actor, { emailAddress: "nope" })).rejects.toBeInstanceOf(ValidationError);
      const address = `shared${Math.random().toString(36).slice(2, 6)}@corp.test`;
      await mailboxUc.connectMailbox(t.mailboxDeps, t.actor, { emailAddress: address });
      await expect(mailboxUc.connectMailbox(u.mailboxDeps, u.actor, { emailAddress: address })).rejects.toBeInstanceOf(ConflictError);
    });

    it("validates settings and keeps them per mailbox", async () => {
      const t = await org();
      const { id } = await mailboxUc.connectMailbox(t.mailboxDeps, t.actor, { emailAddress: `s${Math.random().toString(36).slice(2, 6)}@corp.test` });
      await expect(mailboxUc.updateMailbox(t.mailboxDeps, t.actor, id, { dailySendLimit: 500 })).rejects.toBeInstanceOf(ValidationError);
      await expect(mailboxUc.updateMailbox(t.mailboxDeps, t.actor, id, { workingHours: { timeZone: "Mars/Base", days: {} } })).rejects.toThrow(/time zone/i);
      await expect(mailboxUc.updateMailbox(t.mailboxDeps, t.actor, id, { workingHours: { timeZone: "UTC", days: { "1": [{ start: "9am", end: "18:00" }] } } })).rejects.toThrow(/09:00/);
      await mailboxUc.updateMailbox(t.mailboxDeps, t.actor, id, {
        dailySendLimit: 50,
        signatureHtml: "Ada",
        workingHours: { timeZone: "Asia/Seoul", days: { "1": [{ start: "09:00", end: "18:00" }] } },
      });
      expect(await stores.drizzleMailboxStore.get(t.actor.organizationId, id)).toMatchObject({ dailySendLimit: 50, signatureHtml: "Ada", workingHours: { timeZone: "Asia/Seoul" } });
      await expect(mailboxUc.updateMailbox(t.mailboxDeps, t.member, id, { dailySendLimit: 10 })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("does not let one organization read or change another's mailbox", async () => {
      const t = await org();
      const u = await org();
      const { id } = await mailboxUc.connectMailbox(t.mailboxDeps, t.actor, { emailAddress: `iso${Math.random().toString(36).slice(2, 6)}@corp.test` });
      await expect(mailboxUc.updateMailbox(u.mailboxDeps, u.actor, id, { dailySendLimit: 1 })).rejects.toBeInstanceOf(NotFoundError);
      await expect(mailboxUc.removeMailbox(u.mailboxDeps, u.actor, id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await mailboxUc.listMailboxes(u.mailboxDeps, u.actor)).toEqual([]);
    });

    it("refuses to remove a mailbox with sequences in flight or sending history", async () => {
      const t = await org();
      const { id } = await mailboxUc.connectMailbox(t.mailboxDeps, t.actor, { emailAddress: `rm${Math.random().toString(36).slice(2, 6)}@corp.test` });
      const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name) values (${t.actor.organizationId}, 'email', 'c') returning id`;
      const person = await addPerson(t.actor.organizationId, "x@lead.test");
      const [{ id: enrollment }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, mailbox_id)
        values (${t.actor.organizationId}, ${campaign}, ${person}, 'email', 'active', ${id}) returning id`;
      await expect(mailboxUc.removeMailbox(t.mailboxDeps, t.actor, id)).rejects.toThrow(/still in a sequence/);
      await sql`update campaign_enrollments set status = 'completed' where id = ${enrollment}`;
      await expect(mailboxUc.removeMailbox(t.mailboxDeps, t.actor, id)).rejects.toThrow(/sending history/);
      const { id: spare } = await mailboxUc.connectMailbox(t.mailboxDeps, t.actor, { emailAddress: `rm2${Math.random().toString(36).slice(2, 6)}@corp.test` });
      await mailboxUc.removeMailbox(t.mailboxDeps, t.actor, spare);
      expect(await stores.drizzleMailboxStore.get(t.actor.organizationId, spare)).toBeNull();
    });
  });

  describe("campaigns", () => {
    it("creates a draft with a valid starter sequence", async () => {
      const t = await org();
      await expect(campaignsUc.createCampaign(t.campaignDeps, t.member, { name: "  " })).rejects.toBeInstanceOf(ValidationError);
      const { id } = await campaignsUc.createCampaign(t.campaignDeps, t.member, { name: "  Launch " });
      const { campaign } = await campaignsUc.getCampaignDetail(t.campaignDeps, t.member, id, { tab: "all", search: "", page: 1, pageSize: 50 });
      expect(campaign).toMatchObject({ name: "Launch", status: "draft" });
      expect(campaign.steps).toHaveLength(2);
    });

    it("will not start without a connected mailbox, then runs and pauses", async () => {
      const t = await org();
      const { id } = await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name: "c" });
      const finished = campaignsUc.DEFAULT_STEPS.map((s) => ({ ...s, body: s.body.replace("[[what you help them with]]", "reporting") }));
      await campaignsUc.updateCampaign(t.campaignDeps, t.actor, id, { steps: finished });
      await expect(campaignsUc.changeCampaignStatus(t.campaignDeps, t.actor, id, "active")).rejects.toThrow(/Connect a mailbox/);
      const { id: unfinishedId } = await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name: "unfinished" });
      await expect(campaignsUc.changeCampaignStatus(t.campaignDeps, t.actor, unfinishedId, "active")).rejects.toThrow(/Replace the \[\[bracketed text\]\] in step 1/);
      await mailboxUc.connectMailbox(t.mailboxDeps, t.actor, { emailAddress: `go${Math.random().toString(36).slice(2, 6)}@corp.test` });
      await campaignsUc.changeCampaignStatus(t.campaignDeps, t.actor, id, "active");
      await expect(campaignsUc.changeCampaignStatus(t.campaignDeps, t.actor, id, "active")).rejects.toBeInstanceOf(ConflictError);
      await campaignsUc.changeCampaignStatus(t.campaignDeps, t.actor, id, "paused");
      await expect(campaignsUc.deleteCampaign(t.campaignDeps, t.actor, id)).rejects.toThrow(/Only a draft/);
    });

    it("a resume and a step edit that race cannot launch unchecked steps", async () => {
      const t = await org();
      await mailboxUc.connectMailbox(t.mailboxDeps, t.actor, { emailAddress: `race${Math.random().toString(36).slice(2, 6)}@corp.test` });
      const { id } = await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name: "race" });
      const finished = campaignsUc.DEFAULT_STEPS.map((s) => ({ ...s, body: s.body.replace("[[what you help them with]]", "reporting") }));
      await campaignsUc.updateCampaign(t.campaignDeps, t.actor, id, { steps: finished });
      await campaignsUc.changeCampaignStatus(t.campaignDeps, t.actor, id, "active");
      await campaignsUc.changeCampaignStatus(t.campaignDeps, t.actor, id, "paused");
      const unfinished = sql.json(campaignsUc.DEFAULT_STEPS as never);
      const status = async () => (await sql`select status, steps from campaigns where id = ${id}`)[0];

      // The step edit commits after the resume read the campaign: the resume must not activate the new steps.
      const editLands = { ...t.campaignDeps.campaigns, get: async (...a: Parameters<typeof stores.drizzleCampaignStore.get>) => {
        const row = await stores.drizzleCampaignStore.get(...a);
        await sql`update campaigns set steps = ${unfinished} where id = ${id}`;
        return row;
      } };
      await expect(campaignsUc.changeCampaignStatus({ ...t.campaignDeps, campaigns: editLands }, t.actor, id, "active")).rejects.toBeInstanceOf(ConflictError);
      expect((await status()).status).toBe("paused");

      // The resume commits after the step edit read the campaign: the edit must not change a running campaign.
      await sql`update campaigns set steps = ${sql.json(finished as never)} where id = ${id}`;
      const resumeLands = { ...t.campaignDeps.campaigns, get: async (...a: Parameters<typeof stores.drizzleCampaignStore.get>) => {
        const row = await stores.drizzleCampaignStore.get(...a);
        await sql`update campaigns set status = 'active' where id = ${id}`;
        return row;
      } };
      await expect(campaignsUc.updateCampaign({ ...t.campaignDeps, campaigns: resumeLands }, t.actor, id, { steps: campaignsUc.DEFAULT_STEPS })).rejects.toBeInstanceOf(ConflictError);
      expect(await status()).toMatchObject({ status: "active", steps: finished });
    });

    describe("archive", () => {
      const names = async (t: Awaited<ReturnType<typeof org>>, filter?: "hide" | "only" | "all") => (await campaignsUc.listCampaigns(t.campaignDeps, t.member, filter)).map((c) => c.name).sort();

      async function completed(t: Awaited<ReturnType<typeof org>>, name: string) {
        const { id } = await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name });
        await sql`update campaigns set status = 'completed' where id = ${id}`;
        return id;
      }

      it("archives and unarchives a completed campaign, hides it by default and keeps its sends", async () => {
        const t = await org();
        await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name: "Live" });
        const id = await completed(t, "Done");
        const personId = await addPerson(t.actor.organizationId, "arch@acme.io");
        const [{ id: enrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${t.actor.organizationId}, ${id}, ${personId}, 'email', 'completed') returning id`;
        await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, sent_at) values (${t.actor.organizationId}, ${enrollment}, 1, 'email', 'sent', now())`;

        await campaignsUc.archiveCampaign(t.campaignDeps, t.member, id);
        await campaignsUc.archiveCampaign(t.campaignDeps, t.member, id); // repeating changes nothing
        expect(await names(t)).toEqual(["Live"]);
        expect(await names(t, "only")).toEqual(["Done"]);
        expect(await names(t, "all")).toEqual(["Done", "Live"]);
        expect((await campaignsUc.getCampaignDetail(t.campaignDeps, t.member, id, { tab: "all", search: "", page: 1, pageSize: 50 })).campaign.archivedAt).toBeInstanceOf(Date);
        expect(await sql`select 1 from sends where enrollment_id = ${enrollment}`).toHaveLength(1);
        expect(await sql`select 1 from campaign_enrollments where campaign_id = ${id}`).toHaveLength(1);

        await campaignsUc.unarchiveCampaign(t.campaignDeps, t.member, id);
        expect(await names(t)).toEqual(["Done", "Live"]);
        expect(await names(t, "only")).toEqual([]);
      });

      describe("lifecycle of an archived campaign", () => {
        let t: Awaited<ReturnType<typeof org>>;
        let draft: string;
        let archived: string;
        beforeAll(async () => {
          t = await org();
          ({ id: draft } = await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name: "Draft" }));
          archived = await completed(t, "Done");
          await campaignsUc.archiveCampaign(t.campaignDeps, t.actor, archived);
        });

        it("refuses to archive a draft", async () => {
          await expect(campaignsUc.archiveCampaign(t.campaignDeps, t.actor, draft)).rejects.toThrow(/Only a completed campaign/);
          expect((await sql`select archived_at from campaigns where id = ${draft}`)[0].archived_at).toBeNull();
        });

        it("refuses to start an archived campaign", async () => {
          await expect(campaignsUc.changeCampaignStatus(t.campaignDeps, t.actor, archived, "active")).rejects.toThrow(/archived campaign cannot be started/);
        });

        it("refuses to delete an archived campaign", async () => {
          await expect(campaignsUc.deleteCampaign(t.campaignDeps, t.actor, archived)).rejects.toThrow(/Only a draft/);
        });

        it("refuses to enroll leads into an archived campaign", async () => {
          await expect(campaignsUc.enrollLeads(t.campaignDeps, t.actor, archived, {})).rejects.toBeInstanceOf(ConflictError);
        });

        it("still shows the archived campaign as completed with its archive time", async () => {
          const { campaign } = await campaignsUc.getCampaignDetail(t.campaignDeps, t.actor, archived, { tab: "all", search: "", page: 1, pageSize: 50 });
          expect(campaign).toMatchObject({ id: archived, name: "Done", status: "completed" });
          expect(campaign.archivedAt).toBeInstanceOf(Date);
        });
      });

      it("does not reach another organization's campaign", async () => {
        const a = await org();
        const b = await org();
        const id = await completed(a, "Theirs");
        await expect(campaignsUc.archiveCampaign(b.campaignDeps, b.actor, id)).rejects.toBeInstanceOf(NotFoundError);
        await expect(campaignsUc.unarchiveCampaign(b.campaignDeps, b.actor, id)).rejects.toBeInstanceOf(NotFoundError);
        expect(await stores.drizzleCampaignStore.setArchived(b.actor.organizationId, id, true)).toBe(false);
        expect((await sql`select archived_at from campaigns where id = ${id}`)[0].archived_at).toBeNull();
      });

      it("refuses to archive a campaign that stopped being completed", async () => {
        const t = await org();
        const { id } = await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name: "Racing" });
        // The store checks the status in the same statement, so a stale read cannot archive a live campaign.
        expect(await stores.drizzleCampaignStore.setArchived(t.actor.organizationId, id, true)).toBe(false);
        expect((await sql`select archived_at from campaigns where id = ${id}`)[0].archived_at).toBeNull();
      });
    });

    it("edits steps only while stopped, validates them, and never shrinks under sent leads", async () => {
      const t = await org();
      await mailboxUc.connectMailbox(t.mailboxDeps, t.actor, { emailAddress: `ed${Math.random().toString(36).slice(2, 6)}@corp.test` });
      const { id } = await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name: "c" });
      const steps = campaignsUc.DEFAULT_STEPS.map((s) => ({ ...s, body: s.body.replace("[[what you help them with]]", "reporting") }));
      await campaignsUc.updateCampaign(t.campaignDeps, t.actor, id, { steps });

      await expect(campaignsUc.updateCampaign(t.campaignDeps, t.actor, id, { steps: [{ ...steps[0], body: "" }] })).rejects.toBeInstanceOf(ValidationError);
      await campaignsUc.updateCampaign(t.campaignDeps, t.actor, id, { steps: [steps[0], { ...steps[1], waitDays: 5 }, { stepNumber: 3, kind: "email", body: "last", waitDays: 7 }] });

      await campaignsUc.changeCampaignStatus(t.campaignDeps, t.actor, id, "active");
      await expect(campaignsUc.updateCampaign(t.campaignDeps, t.actor, id, { steps })).rejects.toThrow(/Pause the campaign/);
      await campaignsUc.updateCampaign(t.campaignDeps, t.actor, id, { name: "Renamed" }); // a rename is always fine

      const person = await addPerson(t.actor.organizationId, "far@lead.test");
      await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step) values (${t.actor.organizationId}, ${id}, ${person}, 'email', 'active', 3)`;
      await campaignsUc.changeCampaignStatus(t.campaignDeps, t.actor, id, "paused");
      await expect(campaignsUc.updateCampaign(t.campaignDeps, t.actor, id, { steps })).rejects.toThrow(/cannot have fewer than 3/);
    });

    it("enrolls matching leads once, skipping unsubscribed, do-not-contact, no-email and already-added", async () => {
      const t = await org();
      const orgId = t.actor.organizationId;
      const { id } = await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name: "c" });
      await addPerson(orgId, "ok@lead.test", "Okay");
      await addPerson(orgId, "ok2@lead.test", "Okay");
      await addPerson(orgId, "unsub@lead.test", "Okay");
      const dnc = await addPerson(orgId, "dnc@lead.test", "Okay");
      await addPerson(orgId, null, "Okay");
      await addPerson(orgId, "other@lead.test", "Different");
      await sql`insert into suppression_list (organization_id, email, reason) values (${orgId}, 'unsub@lead.test', 'unsubscribed')`;
      await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${dnc}, ${orgId}, true, 'human', now())`;

      const first = await campaignsUc.enrollLeads(t.campaignDeps, t.actor, id, { query: "okay" });
      expect(first).toEqual({ requested: 5, added: 2, alreadyEnrolled: 0, skippedDuplicate: 0, skippedMissingIdentity: 1, skippedSuppressed: 1, skippedDoNotContact: 1, skippedContact: 0, skippedNoEmail: 1 });

      const again = await campaignsUc.enrollLeads(t.campaignDeps, t.actor, id, { query: "okay" });
      expect(again.added).toBe(0);
      expect(again.alreadyEnrolled).toBe(2);

      const all = await campaignsUc.enrollLeads(t.campaignDeps, t.actor, id, {});
      expect(all.added).toBe(1); // "other@lead.test"
      const detail = await campaignsUc.getCampaignDetail(t.campaignDeps, t.actor, id, { tab: "all", search: "", page: 1, pageSize: 50 });
      expect(detail.enrollments.total).toBe(3);
      expect(detail.enrollments.rows.every((r) => r.status === "pending")).toBe(true);
    });

    it("keeps campaigns and their leads inside one organization", async () => {
      const t = await org();
      const u = await org();
      const { id } = await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name: "mine" });
      await addPerson(u.actor.organizationId, "theirs@lead.test");
      await expect(campaignsUc.enrollLeads(u.campaignDeps, u.actor, id, {})).rejects.toBeInstanceOf(NotFoundError);
      await expect(campaignsUc.changeCampaignStatus(u.campaignDeps, u.actor, id, "active")).rejects.toBeInstanceOf(NotFoundError);
      expect(await campaignsUc.listCampaigns(u.campaignDeps, u.actor)).toEqual([]);
      expect((await campaignsUc.enrollLeads(t.campaignDeps, t.actor, id, {})).added).toBe(0); // their lead is not ours
    });

    it("lists per-campaign counts", async () => {
      const t = await org();
      const { id } = await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name: "counts" });
      for (const [email, status] of [["a@l.test", "pending"], ["b@l.test", "completed"], ["c@l.test", "replied"]] as const) {
        const person = await addPerson(t.actor.organizationId, email);
        await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${t.actor.organizationId}, ${id}, ${person}, 'email', ${status})`;
      }
      const [row] = await campaignsUc.listCampaigns(t.campaignDeps, t.actor);
      expect(row).toMatchObject({ name: "counts", steps: 2, enrolled: 3, completed: 1, stopped: 1, sent: 0 });
    });

    it("previews with a real lead and its custom fields, or a sample when there are none", async () => {
      const t = await org();
      const { id } = await campaignsUc.createCampaign(t.campaignDeps, t.actor, { name: "p" });
      const sample = await campaignsUc.previewStep(t.campaignDeps, t.actor, id, 1);
      expect(sample.usedSampleLead).toBe(true);
      expect(sample.subject).toBe("Quick question, Alex");

      await sql`insert into entity_columns (organization_id, entity, key, name, type) values (${t.actor.organizationId}, 'people', 'x_c_1', '업종', 'text')`;
      await addPerson(t.actor.organizationId, "real@lead.test", "Riley", { x_c_1: "SaaS" });
      const draft = [{ stepNumber: 1, kind: "email" as const, subject: "{{firstName}} in {{업종}}", body: "Hi", waitDays: 0 }];
      const real = await campaignsUc.previewStep(t.campaignDeps, t.actor, id, 1, draft);
      expect(real).toMatchObject({ usedSampleLead: false, subject: "Riley in SaaS" });
      expect(real.bodyText).toContain("Unsubscribe:");
      await expect(campaignsUc.previewStep(t.campaignDeps, t.actor, id, 9)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
