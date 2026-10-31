import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";
import { disk, resolveSource, specifiersOf } from "./source-ast";

/**
 * Who can send a reply (docs/decisions.md, "Agent sends"). The send deps live in one module, and the two files that
 * build a port that sends are the adapters it wires. Only the Send button's two routes and the `send_reply` tool import
 * that module. The background jobs reach none of the three through value imports, however many modules deep, and the
 * MCP endpoint reaches them only through `send_reply`, so a job or any other tool gets deps whose mailer can look in a
 * mailbox and cannot send.
 */

const ROOT = path.resolve(__dirname, "../..");
const posix = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

const SEND_COMPOSITION = "src/contexts/conversations/infrastructure/reply-send-composition.ts";
const SENDING = [SEND_COMPOSITION, "src/contexts/conversations/infrastructure/reply-mailer.ts", "src/contexts/conversations/infrastructure/linkedin-reply-sender.ts"];

/** The agent's one send tool. */
const SEND_TOOL = "src/app/api/mcp/_tools/send-reply.ts";

/** The only importers of the send deps: the routes a person reaches by pressing Send, and the agent's send tool. */
const SEND_IMPORTERS = ["src/app/api/drafts/[id]/send/route.ts", "src/app/api/inbox/[id]/linkedin-reply/route.ts", SEND_TOOL];

/** Entry points that must not reach a port that sends, and the one module each may pass through to reach one. */
const NO_SEND_ENTRIES: Array<[string, string | null]> = [
  ["src/composition/job-registry.ts", null],
  ["src/app/api/mcp/route.ts", SEND_TOOL],
];

/** The import chain from `entry` to each sending module it reaches without passing through `allowed`. */
function sendingReach(entry: string, allowed: string | null): string[] {
  const found: string[] = [];
  const seen = new Set([entry, ...(allowed ? [allowed] : [])]);
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

  it.each(NO_SEND_ENTRIES)("keeps %s from reaching a port that sends except through %s", (entry, allowed) => {
    expect(sendingReach(entry, allowed)).toEqual([]);
  });

  it("reaches the send deps from the MCP endpoint through send_reply", () => {
    expect(sendingReach("src/app/api/mcp/route.ts", null).every((chain) => chain.includes(SEND_TOOL))).toBe(true);
    expect(sendingReach("src/app/api/mcp/route.ts", null)).not.toEqual([]);
  });
});
