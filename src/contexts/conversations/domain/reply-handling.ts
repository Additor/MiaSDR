import { ConflictError, ValidationError } from "@/shared/errors";
import type { WorkflowState } from "./workflow-state";
import { DEFAULT_TYPE_RULES, isCheckMode, isFollowUpsRule, validateTypeRules, type TypeRules } from "./reply-type";

/**
 * Pure reply-handling rules: the fixed groups, validation of reply types and AI-instruction settings, and the rules
 * for a person's type change. Nothing here reads or writes data.
 */

export const REPLY_TYPE_GROUPS = [
  { key: "interested", label: "Interested" },
  { key: "customer", label: "Existing customer" },
  { key: "not_interested", label: "Not interested" },
  { key: "other", label: "Other" },
] as const;

export type ReplyTypeGroup = (typeof REPLY_TYPE_GROUPS)[number]["key"];

export const isReplyTypeGroup = (value: string): value is ReplyTypeGroup => REPLY_TYPE_GROUPS.some((c) => c.key === value);

export const groupLabel = (key: string | null) => REPLY_TYPE_GROUPS.find((c) => c.key === key)?.label ?? "Unclassified";

export interface AiInstructionBlock {
  id: string;
  title: string;
  content: string;
}

export const MAX_INSTRUCTION_BLOCKS = 50;
export const MAX_INSTRUCTION_TITLE = 200;
export const MAX_INSTRUCTION_CONTENT = 8000;
/** The rendered prompt text is cut at this length, so a longer list would silently lose its tail. */
export const MAX_INSTRUCTIONS_TOTAL = 20_000;

const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseInstructionBlocks(value: unknown, label: string): AiInstructionBlock[] {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be a list of instruction blocks.`);
  if (value.length > MAX_INSTRUCTION_BLOCKS) throw new ValidationError(`${label} can hold at most ${MAX_INSTRUCTION_BLOCKS} blocks.`);
  const seen = new Set<string>();
  const blocks = value.map((item, index): AiInstructionBlock => {
    const where = `${label}, block ${index + 1}`;
    if (typeof item !== "object" || item === null) throw new ValidationError(`${where} is not an object.`);
    const { id, title, content } = item as Record<string, unknown>;
    if (typeof id !== "string" || !BLOCK_ID.test(id)) throw new ValidationError(`${where} needs an id of 1 to 64 letters, digits, - or _.`);
    if (seen.has(id)) throw new ValidationError(`${where} repeats the id ${id}.`);
    seen.add(id);
    if (typeof title !== "string" || typeof content !== "string") throw new ValidationError(`${where} needs a title and text.`);
    const cleanTitle = title.trim();
    const cleanContent = content.trim();
    if (cleanTitle === "" || cleanTitle.length > MAX_INSTRUCTION_TITLE) throw new ValidationError(`${where}: the title must be 1 to ${MAX_INSTRUCTION_TITLE} characters.`);
    if (cleanContent === "" || cleanContent.length > MAX_INSTRUCTION_CONTENT) throw new ValidationError(`${where}: the text must be 1 to ${MAX_INSTRUCTION_CONTENT} characters.`);
    return { id, title: cleanTitle, content: cleanContent };
  });
  // Measured the way the prompt renders them: "## title\ntext" blocks joined by a blank line.
  const rendered = blocks.map((b) => `## ${b.title}\n${b.content}`).join("\n\n");
  if (rendered.length > MAX_INSTRUCTIONS_TOTAL) throw new ValidationError(`${label} are longer than ${MAX_INSTRUCTIONS_TOTAL} characters in total.`);
  return blocks;
}

export interface ReplyTypeInput {
  groupKey: ReplyTypeGroup;
  key: string;
  name: string;
  description: string | null;
  classificationGuidance: string | null;
  rules: TypeRules;
}

/** A change to a reply type. `rules` holds only the rules the request names; the use case merges and validates them. */
export type ReplyTypePatch = Partial<Omit<ReplyTypeInput, "groupKey" | "key" | "rules">> & { active?: boolean; sortOrder?: number; rules?: Partial<TypeRules> };

const KEY = /^[a-z][a-z0-9_]*$/;

export function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "s_$1")
    .slice(0, 60);
}

const optionalText = (value: unknown, label: string, max: number): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
  const text = value.trim();
  if (text.length > max) throw new ValidationError(`${label} is longer than ${max} characters.`);
  return text === "" ? null : text;
};

function parseName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > 100) throw new ValidationError("The name must be 1 to 100 characters.");
  return value.trim();
}

/** The type rules a request names, as `checkMode`, `replyDraft` and `followUps` fields. Absent fields stay absent. */
function parseRules(raw: Record<string, unknown>): Partial<TypeRules> {
  const rules: Partial<TypeRules> = {};
  if (raw.checkMode !== undefined) {
    if (!isCheckMode(raw.checkMode)) throw new ValidationError("Check must be before, after or skip.");
    rules.checkMode = raw.checkMode;
  }
  if (raw.replyDraft !== undefined) {
    if (typeof raw.replyDraft !== "boolean") throw new ValidationError("Reply draft must be true or false.");
    rules.replyDraft = raw.replyDraft;
  }
  if (raw.followUps !== undefined) {
    if (!isFollowUpsRule(raw.followUps)) throw new ValidationError("Follow-ups must be continue or stop.");
    rules.followUps = raw.followUps;
  }
  return rules;
}

export function parseReplyTypeInput(raw: Record<string, unknown>): ReplyTypeInput {
  const groupKey = typeof raw.groupKey === "string" ? raw.groupKey : "";
  if (!isReplyTypeGroup(groupKey)) throw new ValidationError("Choose one of the four groups.");
  const name = parseName(raw.name);
  const key = typeof raw.key === "string" && raw.key.trim() !== "" ? raw.key.trim() : keyFromName(name);
  if (!KEY.test(key) || key.length > 60) throw new ValidationError("The key must start with a letter and use only lowercase letters, digits and underscores.");
  return {
    groupKey,
    key,
    name,
    description: optionalText(raw.description, "The description", 500) ?? null,
    classificationGuidance: optionalText(raw.classificationGuidance, "The guidance", 2000) ?? null,
    // A type a person adds has no system role, so any rules are valid for it.
    rules: validateTypeRules({ systemRole: null }, { ...DEFAULT_TYPE_RULES, ...parseRules(raw) }),
  };
}

export function parseReplyTypePatch(raw: Record<string, unknown>): ReplyTypePatch {
  const patch: ReplyTypePatch = {};
  if (raw.name !== undefined) patch.name = parseName(raw.name);
  const description = optionalText(raw.description, "The description", 500);
  if (description !== undefined) patch.description = description;
  const guidance = optionalText(raw.classificationGuidance, "The guidance", 2000);
  if (guidance !== undefined) patch.classificationGuidance = guidance;
  const rules = parseRules(raw);
  if (Object.keys(rules).length > 0) patch.rules = rules;
  if (raw.active !== undefined) {
    if (typeof raw.active !== "boolean") throw new ValidationError("Active must be true or false.");
    patch.active = raw.active;
  }
  if (raw.sortOrder !== undefined) {
    if (typeof raw.sortOrder !== "number" || !Number.isInteger(raw.sortOrder) || raw.sortOrder < 0) throw new ValidationError("The sort order must be a whole number from 0.");
    patch.sortOrder = raw.sortOrder;
  }
  if (Object.keys(patch).length === 0) throw new ValidationError("Nothing to change.");
  return patch;
}

export interface ReplyHandlingSettingsPatch {
  /** The confidence floor. */
  autoApplyConfidence?: number;
}

export function parseReplyHandlingSettings(raw: Record<string, unknown>): ReplyHandlingSettingsPatch {
  const patch: ReplyHandlingSettingsPatch = {};
  if (raw.autoApplyConfidence !== undefined) {
    const value = raw.autoApplyConfidence;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new ValidationError("The auto-apply threshold must be a number from 0 to 1.");
    patch.autoApplyConfidence = Math.round(value * 1000) / 1000;
  }
  if (Object.keys(patch).length === 0) throw new ValidationError("Nothing to change.");
  return patch;
}

export interface ReplyTypeChangeCheck {
  before: { groupKey: string | null; replyTypeId: string | null; replyTypeLocked: boolean; contextVersion: number; workflowState: string };
  target: { groupKey: string; replyTypeId: string | null };
  expectedContextVersion: number;
  /** The person confirmed that a locked customer may leave the customer category. */
  confirmUnlock: boolean;
}

/** What a person's stage move needs to be true. Returns the lock flag the record gets afterwards. */
export function checkReplyTypeChange({ before, target, expectedContextVersion, confirmUnlock }: ReplyTypeChangeCheck): { replyTypeLocked: boolean } {
  if (!isReplyTypeGroup(target.groupKey)) throw new ValidationError("Choose one of the four groups.");
  if (before.contextVersion !== expectedContextVersion) throw new ConflictError("Reply handling changed since you opened it. Reload and try again.");
  if (before.workflowState === "closed") throw new ConflictError("Reply handling is closed. Reopen it before you change the category.");
  if (before.groupKey === target.groupKey && before.replyTypeId === target.replyTypeId) throw new ConflictError("The reply is already in this category.");
  if (before.replyTypeLocked && before.groupKey === "customer" && target.groupKey !== "customer" && !confirmUnlock) {
    throw new ConflictError("This person is locked as Existing customer. Confirm the change to take them out of it.");
  }
  // A customer stays locked so the AI cannot pull them back out; any other category unlocks.
  return { replyTypeLocked: target.groupKey === "customer" };
}

export const WORKFLOW_LABELS: Readonly<Record<string, string>> = {
  unclassified: "Unclassified",
  classifying: "Classifying",
  action_required: "Needs action",
  waiting: "Waiting on them",
  idle: "Idle",
  paused: "Paused",
  closed: "Closed",
  error: "Error",
} satisfies Record<WorkflowState, string>;

export const workflowLabel = (state: string) => WORKFLOW_LABELS[state] ?? state.replace(/_/g, " ");

