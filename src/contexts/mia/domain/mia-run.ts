/**
 * A Mia run is one job a person asked for, carried out step by step in the background. What a run can touch depends on
 * its capability: a run that reads the web sees no Brain item, and a run that reads an item has no way out to the web.
 * "Mia" in docs/decisions.md.
 */

export const MIA_CAPABILITIES = ["brain_fill_url", "brain_fill_text", "brain_sort"] as const;
export type MiaCapability = (typeof MIA_CAPABILITIES)[number];

export const MIA_RUN_STATUSES = ["queued", "running", "waiting_limit", "succeeded", "failed", "cancelled"] as const;
export type MiaRunStatus = (typeof MIA_RUN_STATUSES)[number];

/** A run in one of these is still going, so another one of its kind waits for it. */
export const MIA_ACTIVE_STATUSES = ["queued", "running", "waiting_limit"] as const satisfies readonly MiaRunStatus[];

export const isActiveRun = (status: MiaRunStatus): boolean => (MIA_ACTIVE_STATUSES as readonly MiaRunStatus[]).includes(status);

/** Tools a capability may use. The architecture test pins this table: a tool added here is a decision about what a run can reach. */
export const MIA_RUN_TOOLS: Record<MiaCapability, readonly string[]> = {
  brain_fill_url: ["fetch_page", "suggest_item", "finish"],
  brain_fill_text: ["suggest_item", "finish"],
  brain_sort: ["suggest_item", "finish"],
};

export const MIA_MAX_STEPS = 10;
export const MIA_RUN_TOKENS = 200_000;
export const MIA_MAX_PAGES = 6;
export const MIA_PAGE_CHARS = 12_000;
export const MIA_MAX_LINKS = 50;
export const MIA_MAX_SUGGESTIONS = 30;
export const MIA_MAX_INPUT_CHARS = 100_000;
/** One step: the model call and the tools it runs. */
export const MIA_STEP_TIMEOUT_MS = 40_000;
/** A step must fit before the tick budget ends, so a step never starts with less than this left. */
export const MIA_MIN_STEP_ROOM_MS = 40_000;
export const MIA_PAGE_TIMEOUT_MS = 10_000;
export const MIA_LEASE_MS = 3 * 60_000;
export const MIA_MAX_FAILURES = 3;
export const MIA_CONCURRENCY = 3;

/** The wait before the next try of a step that failed. */
export const miaRetryDelayMs = (failures: number): number => 15_000 * 4 ** Math.max(0, failures - 1);

export const MIA_RUN_LABELS: Record<MiaCapability, string> = {
  brain_fill_url: "Reading the site",
  brain_fill_text: "Reading your text",
  brain_sort: "Sorting a document",
};
