import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Helpers for tests that build a scratch database and run the real migrations against it. Not used by production code. */

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

const ROOT = process.cwd();

export function readJournal(): Journal {
  return JSON.parse(readFileSync(path.join(ROOT, "drizzle/meta/_journal.json"), "utf8")) as Journal;
}

/** A migrations folder holding the journal entries up to `lastIdx`, so the migrator stops there. */
export function folderUpTo(base: string, lastIdx: number): string {
  const dir = path.join(base, `upto-${lastIdx}`);
  mkdirSync(path.join(dir, "meta"), { recursive: true });
  const journal = readJournal();
  const entries = journal.entries.filter((e) => e.idx <= lastIdx);
  writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const e of entries) cpSync(path.join(ROOT, "drizzle", `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
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
