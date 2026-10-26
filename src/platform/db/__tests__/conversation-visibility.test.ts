import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publicConversationText } from "../conversation-visibility";

/**
 * Enumerates every place in src that reads the `conversations` table. A private conversation (personal campaign) must not
 * reach the Inbox, its counts, the CRM, the reply flows or the AI loaders, so each reader either applies the visibility
 * predicate or sits in EXEMPT with a reason. A reader added later without the predicate fails here.
 * The behavioral side lives in personal-campaigns.integration.test.ts.
 */

/** Files that read `conversations` on purpose without the predicate. */
const EXEMPT: Record<string, string> = {
  "src/contexts/conversations/infrastructure/drizzle-conversation-store.ts": "Email ingest. Looks a thread up by mailbox and provider thread id; only LinkedIn replies of a personal campaign create private conversations.",
  "src/contexts/conversations/infrastructure/drizzle-linkedin-conversation-store.ts": "LinkedIn ingest. It must find a private thread to file the next reply under it and to keep it private.",
  "src/contexts/conversations/after-reply/infrastructure/drizzle-sequence-engine.ts": "Sequence follow-ups run on email conversations only (`c.channel = 'email'`), and a private conversation is LinkedIn.",
  "src/contexts/outreach/linkedin/infrastructure/drizzle-personal-thread-store.ts": "The campaign's own thread view. It selects only conversations marked with that campaign.",
  "src/contexts/outreach/infrastructure/drizzle-enrollment-restore.ts": "Restore refuses a person who replied. A private reply counts as a reply, so this safety check must see private conversations.",
  "src/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-campaign-store.ts": "Checks whether a personal campaign holds private conversations (type change guard, thread marker on the lead list). It returns ids and flags, and only for that campaign.",
  "src/test-support/route-client.ts": "Test seeder, not application code. It looks up the record of a message it just created so a seeded classification matches the cross-row validator.",
  "src/contexts/analytics/infrastructure/drizzle-analytics-read-model.ts": "Reply counts per campaign. They are aggregates, and the personal campaign's own replies belong in its numbers.",
  "src/contexts/conversations/infrastructure/person-handling.ts": "Contact delete: `lockPersonForDelete` locks every conversation of the person and `personHandlingBlockers` must find private threads and AI jobs on their messages to block the delete. Both return locks and booleans; the counts and the other reads apply the predicate.",
  "src/contexts/conversations/infrastructure/person-purge.ts": "Contact delete: `purgePersonHandling` deletes every conversation of the person, private ones included, and reads nothing back.",
};

const READS = [/\.from\(conversations\)/, /[iI]nnerJoin\(conversations\b/, /[lL]eftJoin\(conversations\b/, /\b(?:from|join)\s+conversations\b/];

/**
 * Readers of `messages` that never touch `conversations` in the same statement: they select or update a message by its own
 * id or by an idempotency key, and the message carries a conversation id that decides visibility. A new one fails the test
 * until it applies a guard near the read or sits here with the reason its output cannot expose private content.
 */
const MESSAGE_READS = [/\.from\(messages\)/, /\.update\(messages\)/, /\.delete\(messages\)/, /[iI]nnerJoin\(messages\b/, /[lL]eftJoin\(messages\b/, /\b(?:from|join|update)\s+messages\b/];

const MESSAGE_EXEMPT: Record<string, string> = {
  "src/contexts/conversations/infrastructure/drizzle-conversation-store.ts": "Email ingest: finds a stored message by idempotency key to answer `duplicate`; returns ids only.",
  "src/contexts/conversations/infrastructure/drizzle-linkedin-conversation-store.ts": "LinkedIn ingest: finds a stored message by idempotency key to answer `duplicate`; returns ids only.",
  "src/contexts/conversations/after-reply/infrastructure/drizzle-sequence-engine.ts": "Email follow-up engine: reads the latest inbound message of an email conversation to time a step; no content leaves it.",
  "src/contexts/conversations/infrastructure/reply-store-drafts.ts": "Reads the newest subject of a conversation that the same method already loaded through a guarded read (`publicConversation`); a private conversation never gets this far.",
  "src/contexts/outreach/linkedin/infrastructure/drizzle-personal-thread-store.ts": "The campaign's own thread view, limited to conversations marked with that campaign.",
  "src/contexts/outreach/infrastructure/drizzle-enrollment-restore.ts": "Restore refuses a person who replied. A private reply counts as a reply, so this safety check must see private messages; it returns person ids.",
  "src/test-support/route-client.ts": "Test seeder, not application code (see the conversations exemption above).",
  "src/contexts/analytics/infrastructure/drizzle-analytics-read-model.ts": "Reply counts. Aggregates, scoped per campaign by `private_campaign_id`; no message content leaves it.",
  "src/contexts/conversations/ai/infrastructure/drizzle-ai-job-store.ts": "Auto-reply and thread lookups feed the AI loaders, whose conversation reads carry the guard; the message-only lookups here return ids and flags.",
  "src/contexts/conversations/infrastructure/person-handling.ts": "Contact delete: `personHandlingBlockers` looks for a running AI job on any message of the person, private threads included, and returns a boolean.",
  "src/contexts/conversations/infrastructure/person-purge.ts": "Contact delete: `purgePersonHandling` deletes every message of the person's conversations and reads nothing back.",
};

/** Drops `//` and block comments and keeps strings and template literals, so a comment cannot satisfy or hide a read. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && source[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n && source[i] !== c) {
        if (source[i] === "\\") out += source[i++];
        out += source[i++] ?? "";
      }
      out += source[i] ?? "";
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const GUARD = /\b(?:publicConversation(?:Sql|Text)?|visible(?:Record|Draft|ReplyTypePick)(?:Sql|Text))\b/;

/** Reads whose line has no guard within WINDOW lines on either side. Imports and the helper's own file do not count. */
const WINDOW = 40;
export function unguardedReads(source: string, reads: RegExp[]): number[] {
  const lines = stripComments(source).split("\n");
  const guardLines = lines.flatMap((l, i) => (GUARD.test(l) && !l.trimStart().startsWith("import ") ? [i] : []));
  const found: number[] = [];
  lines.forEach((line, i) => {
    if (reads.some((r) => r.test(line)) && !guardLines.some((g) => Math.abs(g - i) <= WINDOW)) found.push(i + 1);
  });
  return found;
}

export function readCount(source: string, reads: RegExp[]): number {
  return stripComments(source).split("\n").filter((l) => reads.some((r) => r.test(l))).length;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("conversation visibility", () => {
  const root = process.cwd();
  const HELPER = "src/platform/db/conversation-visibility.ts";
  const files = walk(path.join(root, "src")).map((f) => path.relative(root, f)).filter((f) => f !== HELPER);
  const sourceOf = (file: string) => readFileSync(path.join(root, file), "utf8");
  const readers = files.map((file) => ({ file, reads: readCount(sourceOf(file), READS), unguarded: unguardedReads(sourceOf(file), READS) })).filter((f) => f.reads > 0);
  const messageReaders = files.map((file) => ({ file, reads: readCount(sourceOf(file), MESSAGE_READS), unguarded: unguardedReads(sourceOf(file), MESSAGE_READS) })).filter((f) => f.reads > 0);

  it("finds the readers it is meant to guard", () => {
    expect(readers.length).toBeGreaterThanOrEqual(10);
    expect(messageReaders.length).toBeGreaterThanOrEqual(10);
  });

  it("applies the predicate next to every read of conversations that is not exempt", () => {
    const missing = readers.filter((r) => !(r.file in EXEMPT) && r.unguarded.length > 0).map((r) => `${r.file}: unguarded read at line ${r.unguarded.join(", ")}`);
    expect(missing).toEqual([]);
  });

  it("applies a guard next to every message-only read, or lists the file with its reason", () => {
    const missing = messageReaders.filter((r) => !(r.file in MESSAGE_EXEMPT) && r.unguarded.length > 0).map((r) => `${r.file}: unguarded message read at line ${r.unguarded.join(", ")}`);
    expect(missing).toEqual([]);
  });

  it("keeps the exemption lists honest", () => {
    const names = new Set(readers.map((r) => r.file));
    expect(Object.keys(EXEMPT).filter((f) => !names.has(f))).toEqual([]);
    const messageNames = new Set(messageReaders.map((r) => r.file));
    expect(Object.keys(MESSAGE_EXEMPT).filter((f) => !messageNames.has(f))).toEqual([]);
    // An exempt file that already guards every read no longer needs the exemption.
    expect(readers.filter((r) => r.file in EXEMPT && r.unguarded.length === 0).map((r) => r.file)).toEqual([]);
    expect(messageReaders.filter((r) => r.file in MESSAGE_EXEMPT && r.unguarded.length === 0).map((r) => r.file)).toEqual([]);
    for (const reason of [...Object.values(EXEMPT), ...Object.values(MESSAGE_EXEMPT)]) expect(reason.length).toBeGreaterThan(20);
  });

  it("states the rule once", () => {
    expect(publicConversationText("c")).toBe("c.private_campaign_id is null");
  });

  describe("the scan itself", () => {
    const read = "const rows = await db.select().from(conversations);";
    it("does not accept a guard name that only appears in a comment", () => {
      expect(unguardedReads(`// publicConversation\n${read}`, READS)).toEqual([2]);
      expect(unguardedReads(`/* must use publicConversationSql(\"c\") */\n${read}`, READS)).toEqual([2]);
      expect(unguardedReads(`/**\n * publicConversation here\n */\n${read}`, READS)).toEqual([4]);
      expect(unguardedReads(`${read} // publicConversation`, READS)).toEqual([1]);
    });

    it("accepts a guard in code, in a template literal and across a few lines", () => {
      expect(unguardedReads(`${read}\n.where(publicConversation)`, READS)).toEqual([]);
      expect(unguardedReads("const q = sql`select 1 from conversations c where ${publicConversationSql(\"c\")}`;", READS)).toEqual([]);
    });

    it("does not accept a guard that sits far from the read", () => {
      expect(unguardedReads(`${read}\n${"\n".repeat(WINDOW + 3)}use(publicConversation);`, READS)).toEqual([1]);
    });

    it("keeps a read inside a template literal and ignores a read that is only in a comment", () => {
      expect(unguardedReads("const q = sql`select * from conversations c`;", READS)).toEqual([1]);
      expect(unguardedReads("// select * from conversations c", READS)).toEqual([]);
      expect(unguardedReads("const url = 'https://example.test/a'; const q = sql`select * from conversations c`;", READS)).toEqual([1]);
    });

    it("recognizes message-only reads", () => {
      expect(unguardedReads("await db.update(messages).set({ important }).where(eq(messages.id, id));", MESSAGE_READS)).toEqual([1]);
      expect(unguardedReads("await db.update(messages).set({ important })\n  .where(inArray(messages.conversationId, publicIds(publicConversation)));", MESSAGE_READS)).toEqual([]);
      expect(unguardedReads("tx.execute(sql`select id from messages where id = ${id}`)", MESSAGE_READS)).toEqual([1]);
    });
  });
});
