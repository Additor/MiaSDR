import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";

/**
 * An audit row commits with its change (docs/decisions.md), so a crash between two writes cannot leave a change no one can
 * see. A use case that writes the row after the change, on the pool, needs a reason here: the change is no one transaction,
 * or it is a call to another system. Everything else passes the entry to its store or writes it through its own `tx`.
 */
const ROOT = path.resolve(__dirname, "../..");
const AFTER_THE_CHANGE: Record<string, string> = {
  "src/contexts/outreach/application/suppression-list.ts": "Pasted addresses stop their sequences in one short transaction each, and the row counts them after.",
  "src/contexts/outreach/application/agent-campaigns.ts": "Pausing an agent's campaigns runs one transaction per campaign, and the row counts them after.",
  "src/contexts/outreach/linkedin/application/linkedin-connect.ts": "Records a call to Unipile, which no transaction can hold.",
  "src/contexts/outreach/linkedin/application/linkedin-operations.ts": "A webhook replay files each event in its own transaction, and the row reports the sum.",
  "src/contexts/outreach/linkedin/application/linkedin-management.ts": "Viewing a secret changes nothing: the row is written first, so a failed write keeps the secret back.",
};

const POOL_WRITE = /\b(?:deps\.)?(?:audit\.record|list\.audit)\(\{/;

describe("audit rows", () => {
  it("commit with the change, or sit in the list with a reason", () => {
    const files = sourceFiles(path.join(ROOT, "src/contexts")).filter((file) => file.includes("/application/"));
    const offenders = files.filter((file) => POOL_WRITE.test(readFileSync(file, "utf8"))).map((file) => path.relative(ROOT, file));
    expect(offenders.sort()).toEqual(Object.keys(AFTER_THE_CHANGE).sort());
  });
});
