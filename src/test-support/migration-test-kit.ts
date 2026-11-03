import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Helpers for tests that build a scratch database and run the real migrations against it. Not used by production code. */

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

const ROOT = process.cwd();

export function readJournal(): Journal {
  return JSON.parse(readFileSync(path.join(ROOT, "drizzle/meta/_journal.json"), "utf8")) as Journal;
}

/** The real migrations plus one more that runs `statement`, as the next release would ship it. */
export function folderWithNext(base: string, statement: string): string {
  const dir = path.join(base, "with-next");
  cpSync(path.join(ROOT, "drizzle"), dir, { recursive: true });
  const journal = readJournal();
  const last = journal.entries[journal.entries.length - 1];
  const next = { ...last, idx: last.idx + 1, tag: "9999_next", when: last.when + 1 };
  writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: [...journal.entries, next] }));
  writeFileSync(path.join(dir, `${next.tag}.sql`), statement);
  return dir;
}

/** The server's maintenance database (to create and drop the scratch one) and the scratch database, from the test URL. */
export function adminAndScratchUrls(source: string, name: string): { admin: string; scratch: string } {
  const scratch = new URL(source);
  const admin = new URL(source);
  admin.pathname = "/postgres";
  scratch.pathname = `/${name}`;
  return { admin: admin.toString(), scratch: scratch.toString() };
}
