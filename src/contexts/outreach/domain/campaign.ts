import { applyMergeFields, applySpin } from "./render";

export interface StepInput {
  stepNumber: number;
  kind: "email";
  subject?: string;
  body: string;
  waitDays: number;
}

export const MAX_STEPS = 10;
export const MAX_WAIT_DAYS = 60;
export const STEP_SUBJECT_MAX = 300;
export const STEP_BODY_MAX = 20_000;

export interface StepIssue {
  step: number | null;
  message: string;
}

/** Braces that open but never close are almost always a typo that would reach a lead as literal text. */
function unbalancedMerge(text: string): boolean {
  const opens = (text.match(/\{\{/g) ?? []).length;
  const closes = (text.match(/\}\}/g) ?? []).length;
  return opens !== closes;
}

export function validateSteps(steps: StepInput[]): StepIssue[] {
  const issues: StepIssue[] = [];
  if (steps.length === 0) return [{ step: null, message: "Add at least one step." }];
  if (steps.length > MAX_STEPS) return [{ step: null, message: `A campaign can have at most ${MAX_STEPS} steps.` }];

  steps.forEach((step, index) => {
    const n = index + 1;
    if (step.stepNumber !== n) issues.push({ step: n, message: "Steps must be numbered 1, 2, 3 in order." });
    if (step.kind !== "email") issues.push({ step: n, message: "An email campaign has email steps only." });
    if (step.body.trim() === "") issues.push({ step: n, message: "The message is empty." });
    if (step.body.length > STEP_BODY_MAX) issues.push({ step: n, message: `The message is longer than ${STEP_BODY_MAX} characters.` });
    if ((step.subject ?? "").length > STEP_SUBJECT_MAX) issues.push({ step: n, message: `The subject is longer than ${STEP_SUBJECT_MAX} characters.` });
    if (index === 0 && (step.subject ?? "").trim() === "") issues.push({ step: n, message: "The first step needs a subject." });
    if (!Number.isInteger(step.waitDays) || step.waitDays < 0 || step.waitDays > MAX_WAIT_DAYS) {
      issues.push({ step: n, message: `Wait must be a whole number of days from 0 to ${MAX_WAIT_DAYS}.` });
    }
    if (index === 0 && step.waitDays !== 0) issues.push({ step: n, message: "The first step goes out right away: wait 0 days." });
    if (index > 0 && step.waitDays < 1) issues.push({ step: n, message: "A follow-up waits at least 1 day." });
    if (unbalancedMerge(step.body) || unbalancedMerge(step.subject ?? "")) {
      issues.push({ step: n, message: "A {{ }} merge field is missing a brace." });
    }
  });
  return issues;
}

export type CampaignStatus = "draft" | "active" | "paused" | "completed";

const TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ["active"],
  active: ["paused", "completed"],
  paused: ["active", "completed"],
  completed: [],
};

/** Which campaigns a list shows: the default hides archived ones. */
export type ArchiveFilter = "hide" | "only" | "all";

export const parseArchiveFilter = (value: string | null | undefined): ArchiveFilter => (value === "only" || value === "all" ? value : "hide");

/** Only a finished campaign can be archived, so archiving never hides one that is still sending. */
export const canArchive = (status: CampaignStatus): boolean => status === "completed";

/** A campaign people can be added to: any but a completed or an archived one. A pick list of campaigns shows these. */
export const acceptsEnrollments = (campaign: { status: string; archivedAt?: Date | string | null }): boolean => campaign.status !== "completed" && !campaign.archivedAt;

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Steps may change while no mail is going out. Existing enrollments keep their position, so the sequence may not shrink under them. */
export const STEPS_EDITABLE: readonly CampaignStatus[] = ["draft", "paused"];

export function stepsEditable(status: CampaignStatus): boolean {
  return STEPS_EDITABLE.includes(status);
}

/**
 * A status change as the use case checked it. The store writes it only while the campaign still has `from` and
 * `checkedSteps`, so a concurrent status change or step edit makes the write miss instead of launching unchecked steps.
 */
export interface CampaignStatusChange<Step> {
  from: CampaignStatus;
  to: CampaignStatus;
  checkedSteps: readonly Step[];
  /**
   * The MCP token of the agent making the change, or null for a person. A move to `active` stores it as
   * `started_via_token_id`; a person's pause sets `person_paused`, so only a person resumes.
   */
  viaTokenId?: string | null;
}

/** Starter templates mark what the author must write as [[like this]]. */
const TEMPLATE_PLACEHOLDER = /\[\[[^\]]*\]\]/;

/** Steps that still contain a [[placeholder]], which would reach leads as literal text. */
export function stepsWithPlaceholders(steps: ReadonlyArray<{ stepNumber: number; subject?: string; body: string }>): number[] {
  return steps.filter((s) => TEMPLATE_PLACEHOLDER.test(s.body) || TEMPLATE_PLACEHOLDER.test(s.subject ?? "")).map((s) => s.stepNumber);
}

/** The subject as it goes out for this lead: spin picks the first option, merge fields fill in, whitespace collapses. */
export function renderSubject(subject: string | undefined, variables: Record<string, string | null>): string {
  return applyMergeFields(applySpin(subject ?? "", () => 0), variables).replace(/\s+/g, " ").trim();
}

/**
 * The first email of a sequence has nothing to thread onto, so a subject that renders empty
 * would send blank. Returns a message when it does, otherwise null.
 */
export function emptyFirstSubjectMessage(steps: StepInput[], variables: Record<string, string | null>): string | null {
  const first = steps[0];
  if (!first) return null;
  if (renderSubject(first.subject, variables) !== "") return null;
  return "The subject of step 1 renders empty. Write a subject, or check that the merge fields in it exist and have values.";
}
