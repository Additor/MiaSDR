/**
 * The gate a push to a campaign puts in front of a verification column. A table that paid to verify its addresses
 * should not enroll the ones it learned are invalid: campaign steps send on their own, and a bounce costs the mailbox
 * its reputation. The gate keeps the rows whose verdict is in the allowed set and names why each other row stays out.
 */

/**
 * A verdict as a verification column stores it; `unverified` for a row the column has not answered (or whose answer is
 * out of date); `changed` for a row whose email is not the address the column checked.
 */
export type PushVerdict = "valid" | "invalid" | "catch_all" | "unknown" | "disposable" | "unverified" | "changed";

const VERDICTS: readonly PushVerdict[] = ["valid", "invalid", "catch_all", "unknown", "disposable"];

/** The statuses a person may let through. Unverified rows never pass: the gate exists to stop them. */
export const PASSABLE_VERDICTS = ["valid", "catch_all", "unknown"] as const;
export type PassableVerdict = (typeof PASSABLE_VERDICTS)[number];

export const VERDICT_LABELS: Record<PushVerdict, string> = {
  valid: "Valid",
  invalid: "Invalid",
  catch_all: "Catch-all",
  unknown: "Unknown",
  disposable: "Disposable",
  unverified: "Not verified",
  changed: "Email changed",
};

interface ColumnLike {
  key: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export interface VerifyColumn {
  key: string;
  name: string;
  /** The column whose address it checks, or null when its email input is not mapped. */
  emailColumnKey: string | null;
}

/** The action an enrichment or waterfall column runs (a waterfall's steps all run its first step's), or null. */
export function runnerActionKey(column: { type: string; config: Record<string, unknown> }): string | null {
  if (column.type === "enrichment") return typeof column.config.actionKey === "string" ? column.config.actionKey : null;
  if (column.type !== "waterfall") return null;
  const first = (column.config.steps as Array<{ actionKey?: unknown }> | undefined)?.[0]?.actionKey;
  return typeof first === "string" ? first : null;
}

/** Enrichment and waterfall columns that verify an email. Their own cell holds the verdict. */
export function verifyColumns(columns: readonly ColumnLike[]): VerifyColumn[] {
  return columns.flatMap((c) => {
    if (runnerActionKey(c) !== "verify-email") return [];
    const email = (c.config.inputs as Record<string, unknown> | undefined)?.email;
    return [{ key: c.key, name: c.name, emailColumnKey: typeof email === "string" && email ? email : null }];
  });
}

interface GateRow {
  id: string;
  cells: Record<string, unknown>;
  cellMeta?: Record<string, unknown>;
}

/**
 * The verdict a row's verification cell gives the email the row holds now. A verdict counts only from a finished run
 * (not one waiting, failed or out of date), and only for the address it checked: a verdict about an earlier address
 * reads `changed`. Runs from before the check recorded its address count by their verdict alone.
 */
export function verdictOf(row: GateRow, columnKey: string, emailKey?: string | null): PushVerdict {
  const cell = row.cells[columnKey];
  if (typeof cell !== "string" || !(VERDICTS as readonly string[]).includes(cell)) return "unverified";
  const meta = row.cellMeta?.[columnKey] as { status?: unknown; checkedEmail?: unknown } | undefined;
  if (meta && meta.status !== undefined && meta.status !== "success") return "unverified";
  if (emailKey && typeof meta?.checkedEmail === "string") {
    const now = typeof row.cells[emailKey] === "string" ? (row.cells[emailKey] as string).trim().toLowerCase() : "";
    if (now !== meta.checkedEmail) return "changed";
  }
  return cell as PushVerdict;
}

/** Splits rows into those that pass and those the gate keeps out, with each kept-out row's verdict. */
export function applyVerifiedGate<R extends GateRow>(rows: readonly R[], columnKey: string, allow: readonly PassableVerdict[], emailKey?: string | null): { pass: R[]; held: Array<{ row: R; verdict: PushVerdict }> } {
  const pass: R[] = [];
  const held: Array<{ row: R; verdict: PushVerdict }> = [];
  for (const row of rows) {
    const verdict = verdictOf(row, columnKey, emailKey);
    if (verdict !== "unverified" && (allow as readonly string[]).includes(verdict)) pass.push(row);
    else held.push({ row, verdict });
  }
  return { pass, held };
}

/** The skip reason a held row gets in the push report. */
export const heldReason = (verdict: PushVerdict, columnName: string) =>
  verdict === "unverified" ? `Not verified yet by ${columnName}` : verdict === "changed" ? `The email changed after ${columnName} checked it` : `Verified ${VERDICT_LABELS[verdict]} by ${columnName}`;
