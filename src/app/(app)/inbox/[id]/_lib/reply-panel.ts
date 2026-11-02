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

/**
 * The key the next Send uses. The same key replays a send, so it stays while the first send may have gone out: no answer, a
 * server error, a send still running or one the provider did not confirm. A refusal wrote nothing and a finished send is done,
 * so the next Send is a new decision.
 */
export function sendKeyAfter(key: string, result: { ok: boolean; status: number; data?: { status?: string } | null }): string {
  if (!result.ok) return result.status === 0 || result.status >= 500 ? key : "";
  return result.data?.status === "delivery_uncertain" || result.data?.status === "in_progress" ? key : "";
}
