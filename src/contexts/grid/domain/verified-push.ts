/**
 * The gate a push to a campaign puts in front of a verification column. A table that paid to verify its addresses
 * should not enroll the ones it learned are invalid: campaign steps send on their own, and a bounce costs the mailbox
 * its reputation. The gate keeps the rows whose verdict is in the allowed set and names why each other row stays out.
 */

/** A verdict as a verification column stores it, or `unverified` for a row the column has not answered. */
export type PushVerdict = "valid" | "invalid" | "catch_all" | "unknown" | "disposable" | "unverified";

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

/** Enrichment and waterfall columns that verify an email. Their own cell holds the verdict. */
export function verifyColumns(columns: readonly ColumnLike[]): VerifyColumn[] {
  return columns.flatMap((c) => {
    if (c.type !== "enrichment" && c.type !== "waterfall") return [];
    const steps = c.config.steps as Array<{ actionKey?: unknown }> | undefined;
    const action = c.type === "waterfall" ? steps?.[0]?.actionKey : c.config.actionKey;
    if (action !== "verify-email") return [];
    const email = (c.config.inputs as Record<string, unknown> | undefined)?.email;
    return [{ key: c.key, name: c.name, emailColumnKey: typeof email === "string" && email ? email : null }];
  });
}

/** The verdict in a verification cell. */
export function verdictOf(cell: unknown): PushVerdict {
  return typeof cell === "string" && (VERDICTS as readonly string[]).includes(cell) ? (cell as PushVerdict) : "unverified";
}

/** Splits rows into those that pass and those the gate keeps out, with each kept-out row's verdict. */
export function applyVerifiedGate<R extends { id: string; cells: Record<string, unknown> }>(rows: readonly R[], columnKey: string, allow: readonly PassableVerdict[]): { pass: R[]; held: Array<{ row: R; verdict: PushVerdict }> } {
  const pass: R[] = [];
  const held: Array<{ row: R; verdict: PushVerdict }> = [];
  for (const row of rows) {
    const verdict = verdictOf(row.cells[columnKey]);
    if (verdict !== "unverified" && (allow as readonly string[]).includes(verdict)) pass.push(row);
    else held.push({ row, verdict });
  }
  return { pass, held };
}

/** The skip reason a held row gets in the push report. */
export const heldReason = (verdict: PushVerdict, columnName: string) => (verdict === "unverified" ? `Not verified yet by ${columnName}` : `Verified ${VERDICT_LABELS[verdict]} by ${columnName}`);
