import { describe, expect, it } from "vitest";
import { blockerText, countLines, expectedQuery, reachLines, type DeleteCounts, type DeletePreview } from "./contact-delete-copy";

const ZERO: DeleteCounts = { deals: { won: 0, lost: 0, wonTitles: [] }, notes: 0, tasks: 0, events: 0, conversations: 0, messages: 0, campaigns: 0, sends: 0 };
const person = (over: Partial<DeletePreview["person"]> = {}): DeletePreview["person"] => ({ id: "p", fullName: "Ada Lovelace", email: "ada@example.com", linkedinUrl: null, doNotContact: false, ...over });

describe("countLines", () => {
  it("leaves out every zero line", () => {
    expect(countLines(ZERO)).toEqual([]);
    expect(countLines({ ...ZERO, notes: 2 })).toEqual(["2 notes"]);
  });

  it("splits won and lost deals and drops a zero part", () => {
    expect(countLines({ ...ZERO, deals: { won: 0, lost: 2, wonTitles: [] } })).toEqual(["2 lost deals. They leave the Pipeline and its totals."]);
    expect(countLines({ ...ZERO, deals: { won: 1, lost: 1, wonTitles: ["Alpha"] } })).toEqual(["1 won deal and 1 lost deal. They leave the Pipeline and its totals. Won: Alpha."]);
  });

  it("names won deals at 3 and leaves them out at 4, where the server sends no titles", () => {
    expect(countLines({ ...ZERO, deals: { won: 3, lost: 0, wonTitles: ["A", "B", "C"] } })[0]).toBe("3 won deals. They leave the Pipeline and its totals. Won: A, B, C.");
    expect(countLines({ ...ZERO, deals: { won: 4, lost: 0, wonTitles: [] } })[0]).toBe("4 won deals. They leave the Pipeline and its totals.");
  });

  it("lists the other counts in order with singular and plural", () => {
    expect(countLines({ ...ZERO, notes: 1, tasks: 2, events: 1, conversations: 1, messages: 3, campaigns: 1, sends: 2 })).toEqual([
      "1 note",
      "2 tasks",
      "1 history line",
      "1 conversation with 3 messages",
      "2 campaign sends in 1 campaign. Campaign reports drop them.",
    ]);
  });
});

describe("reachLines", () => {
  it("keeps a suppressed email blocked", () => {
    const lines = reachLines({ person: person(), suppressionKept: true, linkedinOnlyBlock: false }, "Ada Lovelace");
    expect(lines.suppressed).toBe("ada@example.com stays Email suppressed.");
    expect(lines.unmarked).toBeNull();
    expect(lines.linkedin).toBeNull();
  });

  it("says a marked LinkedIn profile opens again", () => {
    const lines = reachLines({ person: person({ doNotContact: true, email: null, linkedinUrl: "https://www.linkedin.com/in/ada" }), suppressionKept: false, linkedinOnlyBlock: true }, "Ada Lovelace");
    expect(lines.linkedin).toBe("After the delete, campaigns can reach Ada Lovelace's LinkedIn profile again.");
    expect(lines.suppressed).toBeNull();
    expect(lines.unmarked).toBeNull();
  });

  it("offers do not contact for an unmarked email", () => {
    const { unmarked } = reachLines({ person: person(), suppressionKept: false, linkedinOnlyBlock: false }, "Ada Lovelace");
    expect(unmarked && `${unmarked.before}${unmarked.action}${unmarked.after}`).toBe(
      "Deleting does not block ada@example.com. A later import can add Ada Lovelace to a campaign. To stop outreach, mark them do not contact instead.",
    );
  });

  it("always has the bring-back line", () => {
    const lines = reachLines({ person: person({ email: null }), suppressionKept: false, linkedinOnlyBlock: false }, "this contact");
    expect(lines.bringBack).toBe("A re-import, a table handoff or a new message brings this contact back as a lead.");
    expect([lines.suppressed, lines.linkedin, lines.unmarked]).toEqual([null, null, null]);
  });
});

describe("blockerText", () => {
  const time = () => "2026-10-20 09:00";
  it("names the open deal count and each time window", () => {
    expect(blockerText({ reason: "open_deals", deals: [{ id: "d", title: "T", stageName: "New" }] }, "Ada", time)).toBe("Ada has 1 open deal. Close or delete them first.");
    expect(blockerText({ reason: "recent_send", until: "x" }, "this contact", time)).toBe(
      "This contact got a campaign email in the last 24 hours. You can delete the contact after 2026-10-20 09:00. Deleting sooner would free a send in today's mailbox limit.",
    );
    expect(blockerText({ reason: "send_in_flight" }, "this contact", time)).toBe("A message to this contact is still sending. Try again in a few minutes.");
  });
});

describe("expectedQuery", () => {
  it("sends won plus lost as deals", () => {
    expect(expectedQuery({ ...ZERO, deals: { won: 1, lost: 2, wonTitles: [] }, sends: 4 })).toBe("deals=3&notes=0&tasks=0&events=0&conversations=0&messages=0&sends=4");
  });
});
