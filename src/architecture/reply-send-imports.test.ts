import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";
import { disk, resolveSource, specifiersOf } from "./source-ast";

/**
 * Who can send a reply (docs/decisions.md, "AI replies"). The send deps live in one module, and the two files that
 * build a port that sends are the adapters it wires. Only the Send button's two routes import that module. The
 * background jobs and the MCP endpoint reach none of the three through value imports, however many modules deep, so
 * a job or an agent gets deps whose mailer can look in a mailbox and cannot send.
 */

const ROOT = path.resolve(__dirname, "../..");
const posix = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

const SEND_COMPOSITION = "src/contexts/conversations/infrastructure/reply-send-composition.ts";
const SENDING = [SEND_COMPOSITION, "src/contexts/conversations/infrastructure/reply-mailer.ts", "src/contexts/conversations/infrastructure/linkedin-reply-sender.ts"];

/** The only importers of the send deps, each a route a person reaches by pressing Send. */
const SEND_IMPORTERS = ["src/app/api/drafts/[id]/send/route.ts", "src/app/api/inbox/[id]/linkedin-reply/route.ts"];

/** Entry points that must not reach a port that sends. */
const NO_SEND_ENTRIES = ["src/composition/job-registry.ts", "src/app/api/mcp/route.ts"];

/** The import chain from `entry` to each sending module it reaches. */
function sendingReach(entry: string): string[] {
  const found: string[] = [];
  const seen = new Set([entry]);
  const queue = [{ file: entry, chain: [entry] }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const specifier of specifiersOf(current.file, disk)) {
      const target = resolveSource(current.file, specifier, disk);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const chain = [...current.chain, target];
      if (SENDING.includes(target)) found.push(chain.join(" -> "));
      else queue.push({ file: target, chain });
    }
  }
  return found;
}

describe("reply send imports", () => {
  it("lets only the two Send routes import the send deps", () => {
    const importers = sourceFiles(path.join(ROOT, "src"))
      .map(posix)
      .filter((file) => file !== SEND_COMPOSITION && specifiersOf(file, disk).some((specifier) => resolveSource(file, specifier, disk) === SEND_COMPOSITION));
    expect(importers.sort()).toEqual([...SEND_IMPORTERS].sort());
  });

  it("builds the sending adapters in the send deps module only", () => {
    const builders = sourceFiles(path.join(ROOT, "src"))
      .map(posix)
      .filter((file) => !SENDING.includes(file) && specifiersOf(file, disk).some((specifier) => SENDING.slice(1).includes(resolveSource(file, specifier, disk) ?? "")));
    expect(builders).toEqual([]);
  });

  it.each(NO_SEND_ENTRIES)("keeps %s from reaching a port that sends", (entry) => {
    expect(sendingReach(entry)).toEqual([]);
  });
});
