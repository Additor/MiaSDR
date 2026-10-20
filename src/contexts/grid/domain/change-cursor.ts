/**
 * The cursor of the row changes feed. Clients treat it as an opaque string and send back what they got.
 *
 * A row version comes from a sequence when a statement runs, but the row is visible only when its
 * transaction commits, so a lower version can appear after a higher one. The cursor therefore holds
 * two settled marks and a paging position:
 *
 * - `version`: every row with a lower version, written by a transaction older than `watermark`, was delivered.
 * - `watermark`: the oldest transaction id that was still running when the last round began. The next
 *   round re-reads every row such a transaction wrote, whatever its version.
 * - `after`: where the current round has paged to. Equals `version` when the round is settled.
 * - `next`: the watermark the round will settle on, fixed when the round began. Null between rounds.
 */
export interface ChangeCursor {
  version: number;
  /** Null for a bare version sent by an older client. The store substitutes the current horizon. */
  watermark: number | null;
  after: number;
  next: number | null;
}

const WHOLE = /^\d{1,16}$/;
const whole = (text: string): number | null => (WHOLE.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null);

export const formatChangeCursor = (c: { version: number; watermark: number; after: number; next: number | null }): string =>
  `${c.version}:${c.watermark}:${c.after}:${c.next ?? ""}`;

/** Parses `version:watermark:after:next`, or a bare version. Returns null for anything else. */
export function parseChangeCursor(text: string): ChangeCursor | null {
  const bare = whole(text);
  if (bare !== null) return { version: bare, watermark: null, after: bare, next: null };
  const parts = text.split(":");
  if (parts.length !== 4) return null;
  const [version, watermark, after] = [whole(parts[0]), whole(parts[1]), whole(parts[2])];
  const next = parts[3] === "" ? null : whole(parts[3]);
  if (version === null || watermark === null || after === null || (parts[3] !== "" && next === null)) return null;
  return { version, watermark, after, next };
}
