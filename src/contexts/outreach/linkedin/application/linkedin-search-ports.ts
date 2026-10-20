import type { DbHandle } from "@/platform/db/client";
import type { SearchAction, SearchStatus } from "../domain/linkedin-search";
import type { LinkedInCampaignStore } from "./linkedin-campaigns";
import type { LinkedInGatewayProvider, SearchItem } from "./linkedin-ports";
import type { Clock } from "../../application/ports";

export interface LinkedInSearchRecord {
  id: string;
  name: string;
  url: string;
  variant: "classic" | "sales_navigator";
  status: SearchStatus;
  maxResults: number;
  /** Results stored so far. */
  found: number;
  /** Results that became or matched a lead. The rest had no public profile slug. */
  imported: number;
  totalEstimate: number | null;
  pagesFetched: number;
  lastError: string | null;
  targetCampaign: { id: string; name: string } | null;
  /** Name of the account whose cursor the search holds. */
  account: string | null;
  nextPageAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export type { SearchAction };

/** Persistence behind the create, list, pause, resume and cancel use cases. */
export interface LinkedInSearchStore {
  create(organizationId: string, input: { name: string; url: string; maxResults: number; campaignId: string | null }): Promise<string>;
  /** Searches created one at a time, newest first. Queries of a bulk batch are not listed. */
  list(organizationId: string): Promise<LinkedInSearchRecord[]>;
  /** Bulk batches with the number of searches each holds, newest first. */
  listBatches(organizationId: string): Promise<Array<{ id: string; name: string; searches: number }>>;
  get(organizationId: string, id: string): Promise<LinkedInSearchRecord | null>;
  /** Moves the search when its status still allows the action. False means it moved first. */
  apply(organizationId: string, id: string, action: SearchAction): Promise<boolean>;
  /** Connected accounts, to warn on the page when there is none. */
  countConnectedAccounts(organizationId: string): Promise<number>;
}

export interface LinkedInSearchDeps {
  searches: LinkedInSearchStore;
  /** Looks up the target campaign. The store is the LinkedIn campaign store. */
  campaigns: Pick<LinkedInCampaignStore, "get">;
}

/** One page of work: a search and the account that reads it. */
export interface SearchPageClaim {
  searchId: string;
  organizationId: string;
  url: string;
  /** Null for the first page, or after the search restarted on another account. */
  cursor: string | null;
  maxResults: number;
  /** Results stored before this page. */
  found: number;
  pagesFetched: number;
  targetCampaignId: string | null;
  failures: number;
  /** The account's daily search allowance left, before this page. */
  quotaLeft: number;
  gapSeconds: [number, number];
  account: { id: string; providerAccountId: string };
  /** Identifies this claim. A write from an expired claim finds a different value and changes nothing. */
  leaseUntil: Date;
}

export interface FoundResult {
  profileUrl: string;
  personId: string | null;
  item: SearchItem;
}

export interface RecordedPage {
  /** Rows that were new to this search. A page read twice after a crash adds none the second time. */
  inserted: number;
  imported: number;
  status: SearchStatus;
}

/** Port for the search job. Each method is one atomic step. */
export interface LinkedInSearchEngineStore {
  /**
   * One transaction: pick a due search, pick one account for it (the account holding its cursor, else the one with
   * the most allowance left), take both leases. Null when nothing is due or no account is free.
   */
  claimPage(options: { now: Date; random: () => number }): Promise<SearchPageClaim | null>;
  /** The search still wants this page: running or paused, not cancelled, and the claim has not expired. */
  isCurrent(claim: SearchPageClaim): Promise<boolean>;
  /**
   * Stores the page, moves the cursor, counts the allowance and starts the pacing gap.
   * `page.results` runs inside the same transaction, after the claim is confirmed current, so the leads it creates, the
   * enrollments and the stored page commit or roll back together. Null (and `results` not called) when the claim is no longer current.
   */
  recordPage(
    claim: SearchPageClaim,
    page: { results: (tx: DbHandle) => Promise<FoundResult[]>; received: number; nextCursor: string | null; totalEstimate: number | null; done: boolean },
    now: Date,
    gapSeconds: number,
  ): Promise<RecordedPage | null>;
  /** Gives the claim back without moving the cursor. `retryAt` delays the next try. `unknownFailure` counts toward the failure limit. */
  release(claim: SearchPageClaim, input: { error: string | null; retryAt: Date | null; unknownFailure: boolean }): Promise<void>;
  fail(claim: SearchPageClaim, error: string, now: Date): Promise<void>;
  /** The provider refused for a limit: stop the account for a while and send the search to another one from page 1. */
  pauseAccountForLimit(claim: SearchPageClaim, until: Date): Promise<void>;
  /** The provider rejected the account: mark it disconnected and send the search to another one from page 1. */
  disconnectAccount(claim: SearchPageClaim, error: string): Promise<void>;
}

export interface SearchLeadSinkInput {
  organizationId: string;
  searchId: string;
  campaignId: string | null;
  people: Array<{ key: string; profile: string; name: string | null; headline: string | null; memberId?: string | null; url?: string | null }>;
  /** The page transaction: leads and enrollments commit with the stored page, or not at all. */
  tx?: DbHandle;
}

/** Narrow port to the leads context: create or match leads for found people, and enroll them when a campaign is set. */
export interface SearchLeadSink {
  /** The person id of each found key, and how many of them are contacts, which no campaign enrolls. */
  importPeople(input: SearchLeadSinkInput): Promise<{ ids: Map<string, string>; skippedContact: number }>;
}

export interface LinkedInSearchEngineDeps {
  store: LinkedInSearchEngineStore;
  gateways: LinkedInGatewayProvider;
  sink: SearchLeadSink;
  clock: Clock;
  random: () => number;
}

export interface SearchBatchSummary {
  id: string;
  name: string;
  createdAt: Date;
  queries: number;
  /** Query count per status. */
  statuses: Partial<Record<SearchStatus, number>>;
  found: number;
  imported: number;
  campaign: { id: string; name: string } | null;
}

export interface SearchBatchDetail extends SearchBatchSummary {
  accountNames: string[];
  /** The accounts the batch may use. Empty: any connected account. */
  accountIds: string[];
  /** Who uploaded the batch. Null once that user is gone. */
  createdBy: string | null;
  maxResults: number;
  sourceFilename: string | null;
  rowsTotal: number | null;
  rowsRejected: number | null;
  /** The first rows the upload refused, with the reason. */
  rejections: Array<{ row: number; reason: string }>;
  /** At most the first 1000 queries, oldest first. */
  items: Array<{ id: string; url: string; companyName: string | null; status: SearchStatus; found: number; maxResults: number; imported: number; lastError: string | null; sourceRow: number | null; rerunCount: number }>;
}

export interface SearchResultExportRow {
  companyName: string | null;
  searchUrl: string;
  profileUrl: string;
  name: string | null;
  headline: string | null;
  location: string | null;
  networkDistance: string | null;
  inLeads: boolean;
}

/** Persistence behind the batch upload, list, rerun and results export. */
export interface LinkedInSearchBatchStore {
  /** One transaction: the batch and all its queries, or nothing. */
  createBatch(
    organizationId: string,
    input: {
      name: string;
      accountIds: string[];
      maxResults: number;
      campaignId: string | null;
      createdBy: string;
      sourceFilename: string | null;
      rowsTotal: number;
      rowsRejected: number;
      rejections: Array<{ row: number; reason: string }>;
      rows: Array<{ url: string; companyName: string | null; sourceRow: number }>;
    },
  ): Promise<string>;
  /** URLs of searches that still hold a place in the queue, to keep a second upload from queueing them twice. */
  activeUrls(organizationId: string): Promise<string[]>;
  /** Ids of the accounts, out of `ids`, that belong to the organization. */
  knownAccountIds(organizationId: string, ids: string[]): Promise<string[]>;
  /** Connected accounts, to pick the ones a batch may use. */
  accounts(organizationId: string): Promise<Array<{ id: string; name: string }>>;
  list(organizationId: string): Promise<SearchBatchSummary[]>;
  get(organizationId: string, id: string): Promise<SearchBatchDetail | null>;
  /**
   * Puts failed queries of the batch back in the queue (all of them, or those in `ids`). One guarded update: a query that
   * is no longer failed is not touched, so a second call finds nothing. Returns the number moved.
   */
  rerunFailed(organizationId: string, batchId: string, ids: string[] | null): Promise<number>;
  /** Stored results of the batch in pages of `size`, oldest first. */
  resultPages(organizationId: string, batchId: string, size: number): AsyncGenerator<SearchResultExportRow[]>;
  /**
   * One transaction under a lock on the batch: adds queued searches with the batch's result limit and campaign. A URL the batch already
   * holds is counted, not added. When the batch would exceed `maxQueries`, nothing is added and `tooMany` is true.
   */
  addQueries(organizationId: string, batchId: string, rows: Array<{ url: string; companyName: string | null }>, maxQueries: number): Promise<AddedQueries>;
  /**
   * One transaction: locks the named searches (all of the batch when `ids` is null) and deletes them with their stored results.
   * Refuses everything when one of them is running. People, enrollments and sends are never touched. Writes the audit row.
   */
  removeQueries(organizationId: string, batchId: string, ids: string[] | null, audit: BatchAudit): Promise<BatchChange<{ removed: number; resultsRemoved: number; notFound: number }>>;
  /** Same lock and refusal. Deletes the stored results of the named searches (all of the batch when `ids` is null), keeps the searches and zeroes their counters. */
  deleteResults(organizationId: string, batchId: string, ids: string[] | null, audit: BatchAudit): Promise<BatchChange<{ searches: number; resultsRemoved: number; notFound: number }>>;
  /** Same lock and refusal. Deletes the batch, its searches and their stored results. */
  deleteBatch(organizationId: string, batchId: string, audit: BatchAudit): Promise<BatchChange<{ searches: number; resultsRemoved: number }>>;
  /**
   * Makes paused and queued searches of the batch (or those in `ids`) due now: paused ones return to the queue, queued ones lose their
   * pacing gap. Running, failed, finished and limit-paused searches are left alone. Returns how many are due now.
   */
  runNow(organizationId: string, batchId: string, ids: string[] | null): Promise<number>;
}

export interface AddedQueries {
  added: number;
  alreadyInBatch: number;
  tooMany: boolean;
  /** Searches the batch holds after the call. */
  total: number;
}

/** Who changes the batch, for the audit row written with the change. */
export interface BatchAudit {
  actorUserId: string;
}

export type BatchChange<T> = ({ ok: true } & T) | { ok: false; reason: "running"; running: number };

export interface LinkedInSearchBatchDeps {
  batches: LinkedInSearchBatchStore;
  campaigns: LinkedInSearchDeps["campaigns"];
}

/** One connected account with its search counter, as stored. */
export interface SearchAccountUsage {
  id: string;
  name: string;
  usedToday: number;
  usedDay: string | null;
  limitReachedUntil: Date | null;
}

/** Read side of "Search capacity today". */
export interface LinkedInSearchCapacityStore {
  /** People one account may read per UTC day in this organization, and its connected accounts (only those in `accountIds` when it is not empty). */
  usage(organizationId: string, accountIds: string[]): Promise<{ limit: number; accounts: SearchAccountUsage[] }>;
}

export interface LinkedInSearchCapacityDeps {
  capacity: LinkedInSearchCapacityStore;
  now?: () => Date;
}
