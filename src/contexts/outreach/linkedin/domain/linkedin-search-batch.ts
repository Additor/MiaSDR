// Pure rules of a search batch upload: which columns count, which rows are accepted, how duplicates are found. No I/O.
import { normalizeSearchUrl } from "./linkedin-search";

/** A file may carry this many data rows. A larger file is refused whole, so nobody queues half of a list by accident. */
export const MAX_BATCH_ROWS = 500;
export const MAX_BATCH_FILE_BYTES = 1024 * 1024;
export const MAX_COMPANY_NAME = 200;
/** The report lists at most this many refused rows. The count covers all of them. */
export const MAX_REPORTED_REJECTIONS = 50;

export const BATCH_TEMPLATE_HEADERS = ["company_name", "search_url"] as const;
export const BATCH_TEMPLATE_SAMPLE = ["Acme Corp", "https://www.linkedin.com/search/results/people/?keywords=acme%20corp"] as const;

const URL_HEADERS = new Set(["searchurl", "url", "linkedinsearchurl", "linkedinurl", "link"]);
const COMPANY_HEADERS = new Set(["companyname", "company", "account", "accountname"]);

const squash = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface BatchRow {
  /** Row number as a spreadsheet shows it: the header is row 1. */
  row: number;
  url: string;
  variant: "classic" | "sales_navigator";
  companyName: string | null;
}

export interface RejectedRow {
  row: number;
  value: string;
  reason: string;
}

export type ParsedBatch =
  | { ok: false; reason: string }
  | {
      ok: true;
      accepted: BatchRow[];
      rejected: RejectedRow[];
      /** Rows whose search repeats an earlier row of the same file. */
      duplicatesInFile: number;
    };

/** Two copies of one search compare equal when only the order of their parameters differs. */
export function searchUrlKey(url: string): string {
  const parsed = new URL(url);
  const params = [...parsed.searchParams].sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = new URLSearchParams(params).toString();
  return `${parsed.hostname}${parsed.pathname}${query ? `?${query}` : ""}`.toLowerCase();
}

function cleanCompany(value: string | undefined): string | null {
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text === "" ? null : text.slice(0, MAX_COMPANY_NAME);
}

/**
 * Reads the rows of an uploaded sheet. The URL column may be called search_url, url, link and similar, the company
 * column company_name or company. Every row needs a LinkedIn people search; a refused row is reported with its reason
 * and does not stop the others.
 */
export function parseBatchRows(headers: string[], rows: Array<Record<string, string>>): ParsedBatch {
  const urlHeader = headers.find((h) => URL_HEADERS.has(squash(h)));
  if (!urlHeader) return { ok: false, reason: "Add a column named search_url with one LinkedIn people search URL per row." };
  const companyHeader = headers.find((h) => COMPANY_HEADERS.has(squash(h)));
  if (rows.length === 0) return { ok: false, reason: "The file has no rows." };
  if (rows.length > MAX_BATCH_ROWS) {
    return { ok: false, reason: `The file has ${rows.length.toLocaleString("en-US")} rows. A batch takes up to ${MAX_BATCH_ROWS.toLocaleString("en-US")}. Split the file and upload the parts.` };
  }

  const accepted: BatchRow[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Set<string>();
  let duplicatesInFile = 0;
  rows.forEach((record, index) => {
    const row = index + 2;
    const raw = (record[urlHeader] ?? "").trim();
    if (raw === "") {
      rejected.push({ row, value: "", reason: "The search URL is empty." });
      return;
    }
    const result = normalizeSearchUrl(raw);
    if (!result.ok) {
      rejected.push({ row, value: raw.slice(0, 120), reason: result.reason });
      return;
    }
    const key = searchUrlKey(result.value.url);
    if (seen.has(key)) {
      duplicatesInFile++;
      return;
    }
    seen.add(key);
    accepted.push({ row, url: result.value.url, variant: result.value.variant, companyName: companyHeader ? cleanCompany(record[companyHeader]) : null });
  });
  return { ok: true, accepted, rejected, duplicatesInFile };
}

/** The sheet people fill in: one sample row that passes the rules above. */
export function batchTemplateCsv(): string {
  return `${BATCH_TEMPLATE_HEADERS.join(",")}\r\n${BATCH_TEMPLATE_SAMPLE.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")}\r\n`;
}

/** Statuses that a rerun picks up. A failed query keeps its cursor and the people it stored, and continues from the last page. */
export const RERUNNABLE_STATUS = "failed";
/** A search in one of these states already holds a place in the queue, so the same URL is not queued again. */
export const ACTIVE_SEARCH_STATUSES = ["queued", "running", "paused", "paused_limit"] as const;

/** A batch holds at most this many searches in all, so its page lists every one of them. */
export const MAX_BATCH_QUERIES = 1000;
/** Most search ids one remove, delete or run call may name. */
export const MAX_BATCH_IDS = 1000;

/** The text of the 409 answer when a call would touch a search that is running. */
export const SEARCH_RUNNING_MESSAGE = "This search is still running. Pause it, stop it or wait until it finishes, then try again.";

/** Who may remove searches, delete their results or delete the batch: an owner or admin, or the person who created the batch. */
export function canManageBatch(input: { isOwnerOrAdmin: boolean; actorUserId: string; createdBy: string | null }): boolean {
  return input.isOwnerOrAdmin || (input.createdBy !== null && input.createdBy === input.actorUserId);
}

/** URLs added to an existing batch read through the same rules as an uploaded sheet. Row numbers count the pasted list from 1. */
export function parseAddedUrls(urls: string[]): ParsedBatch {
  const parsed = parseBatchRows(["search_url"], urls.map((url) => ({ search_url: url })));
  if (!parsed.ok) return parsed;
  // `parseBatchRows` numbers rows as a sheet does (header is row 1). A pasted list has no header.
  return { ...parsed, accepted: parsed.accepted.map((r) => ({ ...r, row: r.row - 1 })), rejected: parsed.rejected.map((r) => ({ ...r, row: r.row - 1 })) };
}
