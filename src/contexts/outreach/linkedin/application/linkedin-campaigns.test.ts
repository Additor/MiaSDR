import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { DEFAULT_LINKEDIN_STEPS, type LinkedInStep } from "../domain/linkedin";
import {
  archiveLinkedInCampaign,
  changeLinkedInCampaignStatus,
  getLinkedInCampaignDetail,
  previewLinkedInStep,
  type LinkedInAccountLimits,
  type LinkedInCampaignDeps,
  type LinkedInCampaignRecord,
  type LinkedInEnrollmentRow,
  type LinkedInCampaignStore,
} from "./linkedin-campaigns";
import type { EnrollmentAdminStore, SenderRef } from "../../application/enrollment-admin";

const actor: Actor = { userId: "u1", organizationId: "org1", role: "member" };
const NOW = new Date("2026-10-14T10:00:00Z");

function setup(options: { steps?: LinkedInStep[]; status?: LinkedInCampaignRecord["status"]; lead?: Record<string, string | null> | null; accounts?: LinkedInAccountLimits[]; rows?: LinkedInEnrollmentRow[]; archived?: boolean; senders?: SenderRef[]; type?: LinkedInCampaignRecord["type"] } = {}) {
  const campaign: LinkedInCampaignRecord = { id: "c1", name: "Q4", type: options.type ?? "regular", createdBy: "u1", status: options.status ?? "draft", steps: options.steps ?? DEFAULT_LINKEDIN_STEPS, archivedAt: options.archived ? NOW : null, createdAt: NOW };
  const calls: string[] = [];
  const store = {
    get: async (org: string, id: string) => (org === "org1" && id === "c1" ? campaign : null),
    setStatus: async (_org: string, _id: string, status: LinkedInCampaignRecord["status"]) => {
      calls.push(`status:${status}`);
    },
    setArchived: async (_org: string, _id: string, archived: boolean) => {
      calls.push(`archived:${archived}`);
      return true;
    },
    countConnectedAccounts: async () => (options.accounts ?? []).filter((a) => a.status === "connected").length,
    sampleVariables: async () => (options.lead === undefined ? { firstName: "Ada", fullName: "Ada Lovelace", company: "Analytical" } : options.lead),
    listEnrollments: async (_org: string, _id: string, query: { page: number; pageSize: number }) => {
      calls.push(`list:${query.page}:${query.pageSize}`);
      return { rows: options.rows ?? [], total: (options.rows ?? []).length, counts: {}, sent: 7 };
    },
    accountLimits: async () => options.accounts ?? [],
  } as unknown as LinkedInCampaignStore;
  const admin = {
    listSenders: async () => options.senders ?? [],
    findSenders: async (_org: string, _channel: string, ids: string[]) => (options.senders ?? []).filter((s) => ids.includes(s.id)),
    replaceSenders: async (_org: string, _id: string, _channel: string, ids: string[]) => {
      calls.push(`senders:${ids.join(",")}`);
    },
  } as unknown as EnrollmentAdminStore;
  const deps: LinkedInCampaignDeps = { campaigns: store, admin, now: () => NOW };
  return { deps, calls };
}

const step = (n: number, body: string, kind: LinkedInStep["kind"] = n === 1 ? "invitation" : "message"): LinkedInStep => ({ stepNumber: n, kind, body, waitDays: n === 1 ? 0 : 1 });

describe("previewLinkedInStep", () => {
  it("renders the note with a real lead and reports the length against the limit", async () => {
    const { deps } = setup();
    const preview = await previewLinkedInStep(deps, actor, "c1", 1);
    expect(preview).toMatchObject({ kind: "invitation", text: "Hi Ada, I work with teams like Analytical. Happy to connect.", limit: 300, overLimit: false, usedSampleLead: false, leadName: "Ada Lovelace" });
    expect(preview.length).toBe(preview.text.length);
  });

  it("previews unsaved edits and flags a note that is too long after merge fields", async () => {
    const { deps } = setup();
    const long = "{{company}} ".repeat(30);
    const preview = await previewLinkedInStep(deps, actor, "c1", 1, [step(1, long)]);
    expect(preview.length).toBe("Analytical ".repeat(30).trim().length);
    expect(preview.overLimit).toBe(true);
  });

  it("falls back to a sample lead and has no limit for messages", async () => {
    const { deps } = setup({ lead: null });
    const preview = await previewLinkedInStep(deps, actor, "c1", 2);
    expect(preview).toMatchObject({ kind: "message", limit: null, overLimit: false, usedSampleLead: true, leadName: null });
    expect(preview.text).toContain("Alex");
  });

  it("answers not found for a missing step or campaign", async () => {
    const { deps } = setup();
    await expect(previewLinkedInStep(deps, actor, "c1", 9)).rejects.toBeInstanceOf(NotFoundError);
    await expect(previewLinkedInStep(deps, actor, "other", 1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(previewLinkedInStep(deps, { ...actor, organizationId: "org2" }, "c1", 1)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getLinkedInCampaignDetail", () => {
  const account: LinkedInAccountLimits = { id: "a1", name: "Jo", username: "jo", status: "connected", dailyLimit: 20, invitesToday: 3, weeklyLimit: 100, invitesThisWeek: 12, limitReachedUntil: null };

  const row = (id: string, variables: Record<string, string | null>, over: Partial<LinkedInEnrollmentRow> = {}): LinkedInEnrollmentRow => ({
    enrollmentId: id,
    personId: `p-${id}`,
    inboxConversationId: null,
    personName: id,
    profileUrl: null,
    status: "pending",
    stopReason: null,
    currentStep: 0,
    connectionState: "none",
    nextSendAt: null,
    lastSentAt: null,
    variables,
    detail: { headline: null, companyName: null, accountName: null, sends: [], retries: 0, lastError: null, alsoInCampaigns: [], excludedAccounts: [] },
    hasPrivateThread: false,
    ...over,
  });

  it("shows each lead's expected note length and flags the ones over 300", async () => {
    const steps = [step(1, "Hi {{firstName}}, I work with {{company}}. {{pitch}}"), step(2, "Thanks")];
    const rows = [
      row("short", { firstName: "Ada", company: "Acme", pitch: "" }),
      row("long", { firstName: "Ada", company: "Acme", pitch: "x".repeat(300) }),
      row("edge", { firstName: "", company: "", pitch: "y".repeat(250) }),
      row("korean", { firstName: "지수", company: "에이콤", pitch: "" }),
      row("sent", { firstName: "Ada", company: "Acme", pitch: "x".repeat(300) }, { connectionState: "request_sent", status: "active" }),
      row("replied", { firstName: "Ada" }, { status: "replied" }),
    ];
    const { deps } = setup({ steps, rows });
    const detail = await getLinkedInCampaignDetail(deps, actor, "c1", { tab: "all", search: "", page: 1, pageSize: 50 });
    const by = Object.fromEntries(detail.enrollments.rows.map((r) => [r.personName, r]));
    expect(by.short).toMatchObject({ noteLength: "Hi Ada, I work with Acme.".length, noteOverLimit: false });
    expect(by.long.noteOverLimit).toBe(true);
    expect(by.long.noteLength).toBe("Hi Ada, I work with Acme. ".length + 300);
    expect(by.edge).toMatchObject({ noteLength: "Hi, I work with. ".length + 250, noteOverLimit: false });
    expect(by.korean).toMatchObject({ noteLength: "Hi 지수, I work with 에이콤.".length, noteOverLimit: false });
    expect(by.sent).toMatchObject({ noteLength: null, noteOverLimit: false });
    expect(by.replied).toMatchObject({ noteLength: null, noteOverLimit: false });
    expect(by.short).not.toHaveProperty("variables");
  });

  it("has no note length when the first step is not an invitation or the note is empty", async () => {
    const empty = setup({ steps: [step(1, "  "), step(2, "Thanks")], rows: [row("a", { firstName: "Ada" })] });
    expect((await getLinkedInCampaignDetail(empty.deps, actor, "c1", { tab: "all", search: "", page: 1, pageSize: 50 })).enrollments.rows[0].noteLength).toBeNull();
  });

  it("returns the campaign, a page of leads and the account limits", async () => {
    const { deps, calls } = setup({ accounts: [account, { ...account, id: "a2", status: "disconnected" }] });
    const detail = await getLinkedInCampaignDetail(deps, actor, "c1", { tab: "all", search: "", page: 2, pageSize: 50 });
    expect(detail.campaign.id).toBe("c1");
    expect(detail.accounts).toHaveLength(2);
    expect(detail.connectedAccounts).toBe(1);
    expect(detail.enrollments.sent).toBe(7);
    expect(calls).toEqual(["list:2:50"]);
  });

  it("reports zero connected accounts so the page can show the banner", async () => {
    const { deps } = setup();
    expect((await getLinkedInCampaignDetail(deps, actor, "c1", { tab: "all", search: "", page: 1, pageSize: 50 })).connectedAccounts).toBe(0);
  });

  it("hides campaigns of other organizations", async () => {
    const { deps } = setup();
    await expect(getLinkedInCampaignDetail(deps, { ...actor, organizationId: "org2" }, "c1", { tab: "all", search: "", page: 1, pageSize: 50 })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("changeLinkedInCampaignStatus", () => {
  const connected: LinkedInAccountLimits = { id: "a1", name: null, username: null, status: "connected", dailyLimit: 20, invitesToday: 0, weeklyLimit: 100, invitesThisWeek: 0, limitReachedUntil: null };

  it("refuses to start without a connected account", async () => {
    const { deps, calls } = setup({ steps: [step(1, "Hi"), step(2, "Hello")] });
    await expect(changeLinkedInCampaignStatus(deps, actor, "c1", "active")).rejects.toThrow(/Connect a LinkedIn account/);
    expect(calls).toEqual([]);
  });

  it("refuses to start with [[placeholder]] text left", async () => {
    const { deps } = setup({ accounts: [connected] });
    await expect(changeLinkedInCampaignStatus(deps, actor, "c1", "active")).rejects.toBeInstanceOf(ValidationError);
  });

  it("starts a finished draft once an account is connected", async () => {
    const { deps, calls } = setup({ steps: [step(1, "Hi"), step(2, "Hello")], accounts: [connected] });
    await changeLinkedInCampaignStatus(deps, actor, "c1", "active");
    expect(calls).toEqual(["status:active"]);
  });
});

describe("archiveLinkedInCampaign", () => {
  it("archives a completed campaign and refuses one that is still running", async () => {
    const done = setup({ status: "completed" });
    await archiveLinkedInCampaign(done.deps, actor, "c1");
    expect(done.calls).toEqual(["archived:true"]);
    for (const status of ["draft", "active", "paused"] as const) {
      await expect(archiveLinkedInCampaign(setup({ status }).deps, actor, "c1")).rejects.toBeInstanceOf(ConflictError);
    }
  });

  it("does not start an archived campaign", async () => {
    const { deps, calls } = setup({ status: "completed", archived: true });
    await expect(changeLinkedInCampaignStatus(deps, actor, "c1", "active")).rejects.toThrow(/archived campaign cannot be started/);
    expect(calls).toEqual([]);
  });
});

describe("previewLinkedInStep unresolved tokens", () => {
  it("lists a typo as unknown and a missing value as empty", async () => {
    const { deps } = setup({ steps: [step(1, "Hi {{firstNme}}, {{company}} {{title}}")], lead: { firstName: "Ada", company: "Analytical", title: null } });
    const preview = await previewLinkedInStep(deps, actor, "c1", 1);
    expect(preview.unresolved).toEqual([
      { token: "firstNme", reason: "unknown" },
      { token: "title", reason: "empty" },
    ]);
  });
  it("uses unsaved draft steps and the sample lead when there are no leads", async () => {
    const { deps } = setup({ lead: null });
    const preview = await previewLinkedInStep(deps, actor, "c1", 1, [step(1, "{{jobTitle}} at {{companyName}} {{nope}}")]);
    expect(preview.usedSampleLead).toBe(true);
    expect(preview.text).toBe("Head of Sales at Acme");
    expect(preview.unresolved).toEqual([{ token: "nope", reason: "unknown" }]);
  });
  it("lists nothing when every field fills", async () => {
    const { deps } = setup({ steps: [step(1, "Hi {{firstName}}")] });
    expect((await previewLinkedInStep(deps, actor, "c1", 1)).unresolved).toEqual([]);
  });
});
