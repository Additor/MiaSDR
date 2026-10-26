import { describe, expect, it } from "vitest";
import {
  AFTER_REPLY_MODES,
  AFTER_REPLY_MODE_LABELS,
  AFTER_REPLY_OFF,
  ALWAYS_STOPS_ON,
  DEFAULT_AFTER_REPLY_MODE,
  INTERRUPT_REASON_LABELS,
  RUN_STATUS_LABELS,
  afterReplyFlowName,
  afterReplyModeOf,
  endsFlow,
  isAfterReplyMode,
  startBlockedReason,
  type StartBlockFacts,
  runStatusLabel,
  startedByLabel,
  stopReasonLabel,
  type StopReason,
} from "./after-reply";
import { interruptReason, isTerminalReplyType, NO_START_KEYS, type InterruptFacts, type InterruptReason, type RunStatus } from "./sequences";

const ALL_RUN_STATUSES: RunStatus[] = ["active", "paused", "interrupted", "completed", "cancelled"];
const ALL_INTERRUPT_REASONS: InterruptReason[] = ["reply", "do_not_contact", "unsubscribed", "bounce", "suppressed", "terminal_stage", "record_closed", "converted", AFTER_REPLY_OFF];

describe("after a reply mode", () => {
  it("defaults to handing the conversation to the Inbox", () => {
    expect(DEFAULT_AFTER_REPLY_MODE).toBe("handoff");
    expect(AFTER_REPLY_MODES).toEqual(["handoff", "ai_drafts"]);
    expect(Object.keys(AFTER_REPLY_MODE_LABELS).sort()).toEqual([...AFTER_REPLY_MODES].sort());
  });

  it("recognizes only the two modes", () => {
    expect(isAfterReplyMode("handoff")).toBe(true);
    expect(isAfterReplyMode("ai_drafts")).toBe(true);
    expect(isAfterReplyMode("off")).toBe(false);
    expect(isAfterReplyMode(null)).toBe(false);
  });

  it("reads the mode from the flow's state", () => {
    expect(afterReplyModeOf(null)).toBe("handoff");
    expect(afterReplyModeOf({ status: "active", hasPublishedVersion: true })).toBe("ai_drafts");
    expect(afterReplyModeOf({ status: "active", hasPublishedVersion: false })).toBe("handoff");
    expect(afterReplyModeOf({ status: "archived", hasPublishedVersion: true })).toBe("handoff");
  });

  it("names the flow after the campaign", () => {
    expect(afterReplyFlowName("Q3 outbound")).toBe("Q3 outbound (after a reply)");
    expect(afterReplyFlowName("  Q3 outbound  ")).toBe("Q3 outbound (after a reply)");
  });
});

describe("labels", () => {
  it("labels every run status in user words", () => {
    expect(Object.keys(RUN_STATUS_LABELS).sort()).toEqual([...ALL_RUN_STATUSES].sort());
    expect(ALL_RUN_STATUSES.map(runStatusLabel)).toEqual(["Running", "Paused", "Stopped", "Finished", "Cancelled"]);
  });

  it("labels who started a run", () => {
    expect(startedByLabel("ai_assignment")).toBe("Automatic");
    expect(startedByLabel("human_override")).toBe("Restarted by a person");
  });

  it("words every interrupt reason, including the one for turning the setting off", () => {
    const reasons: StopReason[] = [...ALL_INTERRUPT_REASONS];
    for (const reason of reasons) {
      expect(stopReasonLabel(reason)).toBe(INTERRUPT_REASON_LABELS[reason]);
    }
    expect(stopReasonLabel(AFTER_REPLY_OFF)).toBe("Follow-ups turned off for this campaign");
    expect(stopReasonLabel("converted")).toBe("The person became a contact");
  });

  it("words the reasons that people and writes store, and falls back for unknown ones", () => {
    expect(stopReasonLabel("manual")).toBe("A person cancelled the follow-ups");
    expect(stopReasonLabel("stage_moved")).toBe("A person changed the reply category");
    expect(stopReasonLabel("something_new")).toBe("Stopped");
    expect(stopReasonLabel(null)).toBe("Stopped");
    expect(stopReasonLabel("toString")).toBe("Stopped");
  });
});

describe("ALWAYS_STOPS_ON", () => {
  it("lists the lead facts first and the classifications after", () => {
    expect(ALWAYS_STOPS_ON.map((r) => r.id)).toEqual([
      "reply",
      "do_not_contact",
      "unsubscribe",
      "bounce",
      "record_closed",
      "converted",
      "not_interested",
      "out_of_office",
      "left_company",
      "wrong_contact",
      "customer",
    ]);
    expect(new Set(ALWAYS_STOPS_ON.map((r) => r.id)).size).toBe(ALWAYS_STOPS_ON.length);
    for (const rule of ALWAYS_STOPS_ON) expect(rule.label.length).toBeGreaterThan(0);
  });

  it("uses reasons the interrupt rule can produce", () => {
    for (const rule of ALWAYS_STOPS_ON) if (rule.reason) expect(ALL_INTERRUPT_REASONS).toContain(rule.reason);
  });

  it("matches what interruptReason returns for each lead or record fact", () => {
    const base: InterruptFacts = {
      run: { triggerMessageId: "m1", replyTypeId: "s1" },
      record: { latestInboundMessageId: "m1", replyTypeId: "s1", groupKey: "interested", replyTypeKey: "interested", workflowState: "open" },
      doNotContact: false,
      suppression: null,
      contact: false,
      flowActive: true,
    };
    expect(interruptReason(base)).toBeNull();
    const byId = (id: string) => ALWAYS_STOPS_ON.find((r) => r.id === id)?.reason;
    expect(interruptReason({ ...base, record: { ...base.record, latestInboundMessageId: "m2" } })).toBe(byId("reply"));
    expect(interruptReason({ ...base, doNotContact: true })).toBe(byId("do_not_contact"));
    expect(interruptReason({ ...base, suppression: "unsubscribed" })).toBe(byId("unsubscribe"));
    expect(interruptReason({ ...base, suppression: "bounced" })).toBe(byId("bounce"));
    expect(interruptReason({ ...base, record: { ...base.record, workflowState: "closed" } })).toBe(byId("record_closed"));
    expect(interruptReason({ ...base, contact: true })).toBe(byId("converted"));
  });

  it("shares one no-start list with the engine", () => {
    for (const rule of ALWAYS_STOPS_ON) {
      for (const fact of rule.subcategories ?? []) if (fact.replyTypeKey) expect(NO_START_KEYS).toContain(fact.replyTypeKey);
    }
  });

  it("agrees with isTerminalReplyType for every classification it names", () => {
    for (const rule of ALWAYS_STOPS_ON) {
      for (const fact of rule.subcategories ?? []) {
        const terminal = isTerminalReplyType(fact.groupKey, fact.replyTypeKey);
        expect(endsFlow(fact)).toBe(terminal);
        // A rule without a reason keeps a flow from starting but never ends one, so its classification is not terminal.
        expect(terminal).toBe(rule.reason === "terminal_stage");
      }
    }
  });

  it("covers the subcategories that stop a running flow", () => {
    const named = ALWAYS_STOPS_ON.flatMap((r) => r.subcategories ?? []).filter((f) => endsFlow(f));
    const keys = named.map((f) => f.replyTypeKey ?? `category:${f.groupKey}`);
    expect(keys).toEqual(expect.arrayContaining(["category:not_interested", "left_company", "wrong_contact", "connected_to_different_contact", "customer"]));
    // do_not_contact lives in the not_interested category and in the lead fact above, so the category entry covers it.
    expect(isTerminalReplyType("not_interested", "do_not_contact")).toBe(true);
  });
});

describe("why a run cannot start", () => {
  const ok = (): StartBlockFacts => ({
    record: { replyTypeId: "s1", groupKey: "interested", replyTypeKey: "demo_request", replyTypeName: "Demo request", latestInboundMessageId: "m1", lastInboundAt: new Date("2026-10-15T08:00:00Z"), workflowState: "action_required", hasEmail: true },
    conversation: { channel: "email" },
    doNotContact: false,
    suppressed: false,
    contact: false,
    owner: { name: "Autumn", channel: "email", type: "regular", status: "active", archived: false },
    flow: { status: "active", hasPublished: true },
    stepCount: 3,
    answered: false,
  });

  it("returns null when everything allows a start", () => {
    expect(startBlockedReason(ok())).toBeNull();
  });

  it("names the campaign state before the record state", () => {
    const f = ok();
    f.owner = { name: "Autumn", channel: "email", type: "regular", status: "paused", archived: false };
    f.doNotContact = true;
    expect(startBlockedReason(f)).toBe("The campaign Autumn is paused. Resume it to restart follow-ups.");
  });

  it("says a contact starts no follow-ups, before any other reason", () => {
    const f = ok();
    f.contact = true;
    f.doNotContact = true;
    expect(startBlockedReason(f)).toBe("The person is a contact, so follow-ups do not apply.");
  });

  it("names an archived campaign even when its status is active", () => {
    const f = ok();
    f.owner = { name: "Autumn", channel: "email", type: "regular", status: "active", archived: true };
    expect(startBlockedReason(f)).toMatch(/Autumn is archived/);
  });

  it("separates a flow that is off from a flow with no published steps", () => {
    const off = ok();
    off.flow = { status: "archived", hasPublished: true };
    expect(startBlockedReason(off)).toMatch(/AI drafts are off for the campaign Autumn/);
    const empty = ok();
    empty.flow = { status: "active", hasPublished: false };
    expect(startBlockedReason(empty)).toMatch(/no published follow-up steps/);
  });

  it("says a personal campaign cannot draft follow-ups", () => {
    const f = ok();
    f.owner = { name: "Autumn", channel: "email", type: "personal", status: "active", archived: false };
    expect(startBlockedReason(f)).toBe("Personal campaigns keep replies out of the Inbox, so they cannot draft follow-ups.");
  });

  it("names the closing category the reply is classified into", () => {
    const f = ok();
    f.record.groupKey = "not_interested";
    f.record.replyTypeKey = "not_required_right_now";
    f.record.replyTypeName = "Not required right now";
    expect(startBlockedReason(f)).toBe("The reply is classified as Not required right now, so follow-ups do not apply.");
  });

  it("needs a step after the reply when a person already answered", () => {
    const f = ok();
    f.stepCount = 1;
    expect(startBlockedReason(f)).toBeNull();
    f.answered = true;
    expect(startBlockedReason(f)).toMatch(/no follow-up step after the reply/);
  });
});
