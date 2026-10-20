/** Rules for CC addresses seen on inbound mail and chosen on a reply. Pure: no I/O. */

const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;

/** Upper bound on CC addresses remembered from one message. */
export const MAX_INBOUND_CC = 50;
/** Upper bound on CC addresses on one reply. */
export const MAX_REPLY_CC = 20;

export function normalizeCc(value: string): string {
  return value.trim().toLowerCase();
}

export function isCcAddress(value: string): boolean {
  return value.length <= 320 && EMAIL.test(value);
}

function uniqueValid(list: readonly string[], skip: ReadonlySet<string>): string[] {
  const seen = new Set(skip);
  const out: string[] = [];
  for (const raw of list) {
    const email = normalizeCc(raw);
    if (!isCcAddress(email) || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** The Cc list of a message as stored for display: valid, lowercased, unique, capped. Nothing is excluded. */
export function normalizeCcList(cc: readonly string[]): string[] {
  return uniqueValid(cc, new Set()).slice(0, MAX_INBOUND_CC);
}

/**
 * CC addresses worth remembering for a lead: valid, lowercased, unique, without
 * the lead, our own mailbox or the sender.
 */
export function inboundCcCandidates(cc: readonly string[], exclude: { mailbox: string; lead?: string | null; sender?: string | null; others?: readonly string[] }): string[] {
  const skip = new Set([exclude.mailbox, exclude.lead, exclude.sender, ...(exclude.others ?? [])].filter((v): v is string => Boolean(v)).map(normalizeCc));
  return uniqueValid(cc, skip).slice(0, MAX_INBOUND_CC);
}

/** Why a reply's CC list was refused. */
export type ReplyCcError = { code: "invalid"; email: string } | { code: "too_many" } | { code: "unknown"; email: string } | { code: "excluded"; email: string };

/**
 * Validates the CC list a human picked for a reply. Only addresses remembered for the lead
 * (`known`) are accepted, so the composer cannot send to an arbitrary address. The lead and our own
 * mailbox are refused rather than dropped, because the human chose them explicitly.
 */
export function validateReplyCc(
  chosen: readonly string[],
  ctx: { known: readonly string[]; mailbox: string; lead: string | null },
): { ok: true; cc: string[] } | { ok: false; error: ReplyCcError } {
  const known = new Set(ctx.known.map(normalizeCc));
  const blocked = new Set([ctx.mailbox, ctx.lead].filter((v): v is string => Boolean(v)).map(normalizeCc));
  const out: string[] = [];
  for (const raw of chosen) {
    const email = normalizeCc(raw);
    if (!isCcAddress(email)) return { ok: false, error: { code: "invalid", email: raw.trim().slice(0, 100) } };
    if (blocked.has(email)) return { ok: false, error: { code: "excluded", email } };
    if (!known.has(email)) return { ok: false, error: { code: "unknown", email } };
    if (!out.includes(email)) out.push(email);
  }
  if (out.length > MAX_REPLY_CC) return { ok: false, error: { code: "too_many" } };
  return { ok: true, cc: out };
}
