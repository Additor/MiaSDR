import { ValidationError } from "@/shared/errors";
import { BRAIN_FIELDS, parseBrainFields, renderBrainContent, brainFieldValue, type BrainFields } from "./brain-fields";
import { isBrainItemKind, type BrainItemKind, type BrainKind } from "./brain-kinds";
import { parseTags } from "./brain-tags";

/** A Brain item and its versions form one aggregate. These functions hold its rules; the store only locks and saves. */

export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 1000;

export interface BrainItemState {
  kind: BrainKind;
  title: string;
  /** The latest version's fields. Null on a document from before the kinds existed. */
  structuredData: BrainFields | null;
}

export interface BrainItemInput {
  kind: BrainItemKind;
  fields: BrainFields;
  /** Only for a kind without a title field. */
  title?: string;
  description?: string | null;
  tags?: string[];
  alwaysInclude?: boolean;
}

export interface BrainItemPatch {
  /** Only when sorting a document from before the kinds existed. */
  kind?: unknown;
  /** Replaces all the fields. */
  fields?: BrainFields;
  title?: string;
  description?: string | null;
  tags?: string[];
  alwaysInclude?: boolean;
  active?: boolean;
}

export interface NewBrainItem {
  kind: BrainItemKind;
  title: string;
  description: string | null;
  tags: string[];
  alwaysInclude: boolean;
  structuredData: BrainFields;
  content: string;
}

/** What one edit changes on the item. `version` is set when it needs a new version. */
export interface BrainItemChange {
  kind?: BrainItemKind;
  title?: string;
  description?: string | null;
  tags?: string[];
  alwaysInclude?: boolean;
  active?: boolean;
  version?: { structuredData: BrainFields; content: string };
}

/** A document from before the kinds existed has no fields yet: a person sorts it into a kind. */
export const isLegacyBrainItem = (item: Pick<BrainItemState, "structuredData">): boolean => item.structuredData === null;

function cleanTitle(raw: string): string {
  const title = raw.trim();
  if (title === "" || title.length > MAX_TITLE) throw new ValidationError(`The title must be 1 to ${MAX_TITLE} characters.`);
  return title;
}

function cleanDescription(raw: string | null | undefined): string | null {
  const description = raw?.trim() ?? "";
  if (description.length > MAX_DESCRIPTION) throw new ValidationError(`The description must be at most ${MAX_DESCRIPTION} characters.`);
  return description === "" ? null : description;
}

function cleanTags(raw: string[]): string[] {
  const parsed = parseTags(raw);
  if (parsed.problem !== null) throw new ValidationError(parsed.problem);
  return parsed.tags;
}

/** The title of an item with these fields: the title field's value, or the title a person wrote. */
function titleOf(kind: BrainItemKind, fields: BrainFields, written: string | undefined): string {
  const { titleField } = BRAIN_FIELDS[kind];
  if (titleField === undefined) return cleanTitle(written ?? "");
  if (written !== undefined) throw new ValidationError("The title comes from the name field of this kind.");
  return brainFieldValue(fields, titleField) as string;
}

export function createBrainItem(input: BrainItemInput): NewBrainItem {
  if (!isBrainItemKind(input.kind)) throw new ValidationError("Unknown item kind.");
  const structuredData = parseBrainFields(input.kind, input.fields);
  return {
    kind: input.kind,
    title: titleOf(input.kind, structuredData, input.title),
    description: cleanDescription(input.description),
    tags: cleanTags(input.tags ?? []),
    alwaysInclude: input.alwaysInclude ?? false,
    structuredData,
    content: renderBrainContent(input.kind, structuredData),
  };
}

/** The kind the patch's fields belong to. Only a document from before the kinds existed can take one. */
function kindOfEdit(current: BrainItemState, patch: BrainItemPatch): BrainItemKind {
  if (patch.kind !== undefined) {
    if (!isLegacyBrainItem(current)) throw new ValidationError("An item keeps its kind.");
    if (!isBrainItemKind(patch.kind)) throw new ValidationError("Choose a kind for this document.");
    return patch.kind;
  }
  if (!isBrainItemKind(current.kind)) throw new ValidationError("Choose a kind for this document.");
  return current.kind;
}

/** Everything the patch changes, or a `ValidationError`. The caller has locked the item, so `current` is what it replaces. */
export function reviseBrainItem(current: BrainItemState, patch: BrainItemPatch): BrainItemChange {
  const change: BrainItemChange = {};
  if (patch.description !== undefined) change.description = cleanDescription(patch.description);
  if (patch.tags !== undefined) change.tags = cleanTags(patch.tags);
  if (patch.alwaysInclude !== undefined) change.alwaysInclude = patch.alwaysInclude;
  if (patch.active !== undefined) change.active = patch.active;

  if (patch.fields === undefined) {
    if (patch.kind !== undefined) throw new ValidationError("Fill in the fields of the new kind.");
    if (patch.title !== undefined) {
      if (isBrainItemKind(current.kind) && BRAIN_FIELDS[current.kind].titleField !== undefined) throw new ValidationError("The title comes from the name field of this kind.");
      change.title = cleanTitle(patch.title);
    }
    return change;
  }

  const kind = kindOfEdit(current, patch);
  const structuredData = parseBrainFields(kind, patch.fields);
  const sorting = isLegacyBrainItem(current);
  if (sorting && patch.kind !== undefined) change.kind = kind;
  const hasTitleField = BRAIN_FIELDS[kind].titleField !== undefined;
  if (hasTitleField || patch.title !== undefined) change.title = titleOf(kind, structuredData, patch.title);
  else if (sorting) change.title = cleanTitle(current.title);

  const sameFields = !sorting && JSON.stringify(parseBrainFields(kind, current.structuredData as BrainFields)) === JSON.stringify(structuredData);
  if (!sameFields) change.version = { structuredData, content: renderBrainContent(kind, structuredData) };
  return change;
}
