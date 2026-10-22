import { ConflictError, ValidationError } from "@/shared/errors";

/**
 * Pure reply-handling rules: the fixed categories, validation of the taxonomy and AI-instruction settings, and
 * the rules for a person's stage move. Nothing here reads or writes data.
 */

export const REPLY_CATEGORIES = [
  { key: "interested", label: "Interested" },
  { key: "customer", label: "Existing customer" },
  { key: "not_interested", label: "Not interested" },
  { key: "other", label: "Other" },
] as const;

export type CategoryKey = (typeof REPLY_CATEGORIES)[number]["key"];

export const isCategoryKey = (value: string): value is CategoryKey => REPLY_CATEGORIES.some((c) => c.key === value);

export const categoryLabel = (key: string | null) => REPLY_CATEGORIES.find((c) => c.key === key)?.label ?? "Unclassified";

/** This subcategory drives the do-not-contact paths, so it can be neither deleted nor archived. */
export const PROTECTED_SUBCATEGORY_KEY = "do_not_contact";

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

export interface SubcategoryInput {
  categoryKey: CategoryKey;
  key: string;
  name: string;
  description: string | null;
  classificationGuidance: string | null;
  reviewRequired: boolean;
  /** Position in the reply categories. Null marks an unranked outcome. */
  stageRank: number | null;
}

export type SubcategoryPatch = Partial<Omit<SubcategoryInput, "categoryKey" | "key">> & { active?: boolean; sortOrder?: number };

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

function parseRank(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) throw new ValidationError("The position must be a whole number from 1 to 100, or empty.");
  return value;
}

export function parseSubcategoryInput(raw: Record<string, unknown>): SubcategoryInput {
  const categoryKey = typeof raw.categoryKey === "string" ? raw.categoryKey : "";
  if (!isCategoryKey(categoryKey)) throw new ValidationError("Choose one of the four categories.");
  const name = parseName(raw.name);
  const key = typeof raw.key === "string" && raw.key.trim() !== "" ? raw.key.trim() : keyFromName(name);
  if (!KEY.test(key) || key.length > 60) throw new ValidationError("The key must start with a letter and use only lowercase letters, digits and underscores.");
  return {
    categoryKey,
    key,
    name,
    description: optionalText(raw.description, "The description", 500) ?? null,
    classificationGuidance: optionalText(raw.classificationGuidance, "The guidance", 2000) ?? null,
    reviewRequired: raw.reviewRequired === true,
    stageRank: raw.stageRank === undefined ? null : parseRank(raw.stageRank),
  };
}

export function parseSubcategoryPatch(raw: Record<string, unknown>): SubcategoryPatch {
  const patch: SubcategoryPatch = {};
  if (raw.name !== undefined) patch.name = parseName(raw.name);
  const description = optionalText(raw.description, "The description", 500);
  if (description !== undefined) patch.description = description;
  const guidance = optionalText(raw.classificationGuidance, "The guidance", 2000);
  if (guidance !== undefined) patch.classificationGuidance = guidance;
  if (raw.reviewRequired !== undefined) {
    if (typeof raw.reviewRequired !== "boolean") throw new ValidationError("Review required must be true or false.");
    patch.reviewRequired = raw.reviewRequired;
  }
  if (raw.stageRank !== undefined) patch.stageRank = parseRank(raw.stageRank);
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

export interface PipelineSettingsPatch {
  autoApplyConfidence?: number;
  reviewOther?: boolean;
  customerRequiresReview?: boolean;
}

export function parsePipelineSettings(raw: Record<string, unknown>): PipelineSettingsPatch {
  const patch: PipelineSettingsPatch = {};
  if (raw.autoApplyConfidence !== undefined) {
    const value = raw.autoApplyConfidence;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new ValidationError("The auto-apply threshold must be a number from 0 to 1.");
    patch.autoApplyConfidence = Math.round(value * 1000) / 1000;
  }
  for (const flag of ["reviewOther", "customerRequiresReview"] as const) {
    if (raw[flag] === undefined) continue;
    if (typeof raw[flag] !== "boolean") throw new ValidationError(`${flag} must be true or false.`);
    patch[flag] = raw[flag];
  }
  if (Object.keys(patch).length === 0) throw new ValidationError("Nothing to change.");
  return patch;
}

export interface StageMoveCheck {
  before: { categoryKey: string | null; subcategoryId: string | null; categoryLocked: boolean; contextVersion: number; workflowState: string };
  target: { categoryKey: string; subcategoryId: string | null };
  expectedContextVersion: number;
  /** The person confirmed that a locked customer may leave the customer category. */
  confirmUnlock: boolean;
}

/** What a person's stage move needs to be true. Returns the lock flag the record gets afterwards. */
export function checkStageMove({ before, target, expectedContextVersion, confirmUnlock }: StageMoveCheck): { categoryLocked: boolean } {
  if (!isCategoryKey(target.categoryKey)) throw new ValidationError("Choose one of the four categories.");
  if (before.contextVersion !== expectedContextVersion) throw new ConflictError("Reply handling changed since you opened it. Reload and try again.");
  if (before.workflowState === "closed") throw new ConflictError("Reply handling is closed. Reopen it before you change the category.");
  if (before.categoryKey === target.categoryKey && before.subcategoryId === target.subcategoryId) throw new ConflictError("The reply is already in this category.");
  if (before.categoryLocked && before.categoryKey === "customer" && target.categoryKey !== "customer" && !confirmUnlock) {
    throw new ConflictError("This person is locked as Existing customer. Confirm the change to take them out of it.");
  }
  // A customer stays locked so the AI cannot pull them back out; any other category unlocks.
  return { categoryLocked: target.categoryKey === "customer" };
}

export const WORKFLOW_LABELS: Record<string, string> = {
  unclassified: "Unclassified",
  classifying: "Classifying",
  action_required: "Needs action",
  waiting: "Waiting on them",
  idle: "Idle",
  paused: "Paused",
  closed: "Closed",
  error: "Error",
};

export const workflowLabel = (state: string) => WORKFLOW_LABELS[state] ?? state.replace(/_/g, " ");

