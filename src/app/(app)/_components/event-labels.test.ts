import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_LABELS, eventLabel } from "./event-labels";

/** Namespaces of `events.event_type`. A literal such as "deal.created" or 'sequence.cancelled' in these is an event type. */
const NAMESPACES = ["reply_type", "reply_type_pick", "contact_policy", "contact", "draft", "workflow", "sequence", "enrollment", "outreach", "lifecycle", "deal", "assignee"];
const LITERAL = new RegExp(`["'\`]((?:${NAMESPACES.join("|")})\\.[a-z_]+)["'\`]`, "g");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test-support" || name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith("test-kit.ts") ? [path] : [];
  });
}

/** Event types the product code writes, read from its string literals. */
function writtenEventTypes(): string[] {
  const found = new Set<string>();
  for (const path of sources("src")) {
    if (path.endsWith("event-labels.ts")) continue;
    for (const match of readFileSync(path, "utf8").matchAll(LITERAL)) found.add(match[1]);
  }
  return [...found].sort();
}

describe("EVENT_LABELS", () => {
  it("labels every event type the code writes", () => {
    const written = writtenEventTypes();
    // The scan must see the types this plan adds, or it is not reading the right files.
    expect(written).toEqual(expect.arrayContaining(["lifecycle.converted", "deal.created", "deal.stage_moved", "deal.updated", "deal.deleted", "reply_type.changed", "sequence.started", "assignee.changed"]));
    expect(written.filter((type) => !(type in EVENT_LABELS))).toEqual([]);
  });

  it("uses the to-be wording", () => {
    expect(eventLabel({ eventType: "reply_type.changed" })).toBe("Changed the reply type");
    expect(eventLabel({ eventType: "lifecycle.converted" })).toBe("Became a contact");
    expect(eventLabel({ eventType: "deal.created" })).toBe("Created deal");
    expect(eventLabel({ eventType: "assignee.changed", toData: { assignedTo: "u1", assigneeName: "Ann" } })).toBe("Assigned to Ann");
    expect(eventLabel({ eventType: "assignee.changed", toData: { assignedTo: "u1", assigneeName: null } })).toBe("Assigned the conversation");
    expect(eventLabel({ eventType: "assignee.changed", toData: { assignedTo: null, assigneeName: null } })).toBe("Unassigned the conversation");
    expect(eventLabel({ eventType: "deal.stage_moved", toData: { stageName: "Proposal" } })).toBe("Moved deal to Proposal");
    expect(eventLabel({ eventType: "deal.stage_moved", toData: null })).toBe("Moved deal to another stage");
  });

  it("never says record and falls back to the readable token", () => {
    expect(Object.values(EVENT_LABELS).filter((label) => /\brecords?\b/i.test(label))).toEqual([]);
    expect(eventLabel({ eventType: "something.new_thing" })).toBe("Something new thing");
  });
});
