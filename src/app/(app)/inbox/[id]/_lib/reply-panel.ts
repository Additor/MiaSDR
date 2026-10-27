/**
 * Pure rules for the reply card around a draft job. While a job queued or running writes the next draft, the card says
 * Drafting above the draft it still shows, and Regenerate stays outline and off: a second draft would race the job's.
 */

/** Draft states the card still shows while a new draft is on its way. */
const SHOWN_WHILE_DRAFTING = new Set(["awaiting_review", "failed", "stale"]);

export interface RegenerateControl {
  variant: "default" | "outline";
  disabled: boolean;
}

/** Drafting shows above an open draft while a draft job waits or runs. Without a draft the card says Drafting on its own. */
export const draftingAbove = (draft: { status: string } | null, drafting: boolean): boolean => drafting && draft !== null && SHOWN_WHILE_DRAFTING.has(draft.status);

/**
 * Regenerate leads only under an out-of-date draft, when no decision on the type line holds the filled button and no draft
 * job is writing the next draft. While a job runs it is outline and off.
 */
export function regenerateControl(input: { status: string; decisionWaiting: boolean; drafting: boolean; busy: boolean; aiConfigured: boolean }): RegenerateControl {
  return {
    variant: input.status === "stale" && !input.decisionWaiting && !input.drafting ? "default" : "outline",
    disabled: input.busy || !input.aiConfigured || input.drafting,
  };
}

/** The 409 a person's draft request answers when the thread moved while the AI wrote: the page reloads to show what changed. */
export const reloadsAfter = (result: { ok: boolean; status: number }): boolean => !result.ok && result.status === 409;
