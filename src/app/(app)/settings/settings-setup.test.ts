import { describe, expect, it } from "vitest";
import { openSetupLinks, type SetupStep } from "./settings-setup";

const step = (over: Partial<SetupStep> & Pick<SetupStep, "id">): SetupStep => ({
  title: over.id,
  description: `${over.id} description`,
  optional: false,
  status: "todo",
  detail: null,
  href: `/${over.id}`,
  ...over,
});

describe("openSetupLinks", () => {
  it("lists open required steps in checklist order", () => {
    const links = openSetupLinks([step({ id: "profile" }), step({ id: "mailbox" }), step({ id: "leads" })]);
    expect(links.map((l) => l.id)).toEqual(["profile", "mailbox", "leads"]);
    expect(links[1]).toMatchObject({ title: "mailbox", href: "/mailbox" });
  });

  it("skips optional and finished steps", () => {
    const links = openSetupLinks([step({ id: "profile", status: "done" }), step({ id: "linkedin", optional: true }), step({ id: "mailbox" })]);
    expect(links.map((l) => l.id)).toEqual(["mailbox"]);
  });

  it("uses the count as the reason when a step needs attention", () => {
    const [link] = openSetupLinks([step({ id: "mailbox", status: "attention", detail: "2 mailboxes added, none connected" })]);
    expect(link.reason).toBe("2 mailboxes added, none connected");
  });

  it("uses the step description when nothing was started, even if a detail exists", () => {
    const [link] = openSetupLinks([step({ id: "mailbox", detail: "ignored" })]);
    expect(link.reason).toBe("mailbox description");
  });

  it("returns nothing once every required step is done", () => {
    expect(openSetupLinks([step({ id: "a", status: "done" }), step({ id: "b", optional: true })])).toEqual([]);
    expect(openSetupLinks([])).toEqual([]);
  });
});
