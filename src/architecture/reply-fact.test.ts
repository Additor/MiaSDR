import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";

/**
 * "Did this person reply?" has one reading (`genuineInboundSql`), and a reply stops outreach through one function
 * (`stopPersonOutreachOnReplyTx`). Readers that parsed the flag by hand came to different answers, and a second stop left the
 * person's other campaigns running and wrote no event.
 */
const ROOT = path.resolve(__dirname, "../..");
const relative = (file: string) => path.relative(ROOT, file);
const files = () => sourceFiles(path.join(ROOT, "src")).map((file) => ({ file: relative(file), text: readFileSync(file, "utf8") }));

describe("the reply fact", () => {
  it("parses the auto-reply flag in one place", () => {
    const parsers = files().filter(({ text }) => /raw\s*->>\s*'autoReply'/.test(text)).map(({ file }) => file);
    expect(parsers).toEqual(["src/platform/db/conversation-visibility.ts"]);
  });

  it("moves an enrollment to replied in one place", () => {
    const writers = files().filter(({ text }) => /haltOutcome\("replied"\)|halt\w*\([^)]*"replied"/.test(text)).map(({ file }) => file);
    expect(writers).toEqual(["src/contexts/conversations/after-reply/infrastructure/sequence-stop.ts"]);
  });
});
