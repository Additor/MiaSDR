import { ConflictError, ValidationError } from "@/shared/errors";
import { BRAIN_FIELDS, parseBrainFields, renderBrainContent, sameBrainFields, brainFieldValue, type BrainFields } from "./brain-fields";
import { SINGLE_ITEM_KIND, isBrainItemKind, type BrainItemKind, type BrainKind } from "./brain-kinds";
import { parseTags } from "./brain-tags";

/** A Brain item and its versions form one aggregate. These functions hold its rules; the store only locks and saves. */

export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 1000;

export interface BrainItemState {
  kind: BrainKind;
  title: string;
  description: string | null;
  tags: string[];
  alwaysInclude: boolean;
  active: boolean;
  revision: number;
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
  /** Replaces all the fields. It needs `revision`, since a form sends every field and a stale one would undo a later edit. */
  fields?: BrainFields;
  /** The item's revision when the person opened it. */
  revision?: number;
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

/** What one edit changes on the item, without what it leaves as it was. `version` is set when it needs a new version. */
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

/** An archived company profile cannot come back beside an active one. */
export const isRestoreBlocked = (item: Pick<BrainItemState, "kind" | "active">, hasCompanyProfile: boolean): boolean => !item.active && item.kind === SINGLE_ITEM_KIND && hasCompanyProfile;

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

/** Everything the patch changes, or a `ValidationError` or a stale `ConflictError`. The caller has locked the item, so `current` is what it replaces. */
export function reviseBrainItem(current: BrainItemState, patch: BrainItemPatch): BrainItemChange {
  if (patch.fields !== undefined && patch.revision === undefined) throw new ValidationError("An edit of the fields needs the revision it started from.");
  if (patch.revision !== undefined && patch.revision !== current.revision) {
    throw new ConflictError("Someone changed this item after you opened it. Close this form, open it again and redo your change.", { code: "stale_version", revision: current.revision });
  }

  const change: BrainItemChange = {};
  if (patch.description !== undefined) {
    const description = cleanDescription(patch.description);
    if (description !== current.description) change.description = description;
  }
  if (patch.tags !== undefined) {
    const tags = cleanTags(patch.tags);
    if (tags.join("\n") !== current.tags.join("\n")) change.tags = tags;
  }
  if (patch.alwaysInclude !== undefined && patch.alwaysInclude !== current.alwaysInclude) change.alwaysInclude = patch.alwaysInclude;
  if (patch.active !== undefined && patch.active !== current.active) change.active = patch.active;

  const setTitle = (title: string) => {
    if (title !== current.title) change.title = title;
  };

  if (patch.fields === undefined) {
    if (patch.kind !== undefined) throw new ValidationError("Fill in the fields of the new kind.");
    if (patch.title !== undefined) {
      if (isBrainItemKind(current.kind) && BRAIN_FIELDS[current.kind].titleField !== undefined) throw new ValidationError("The title comes from the name field of this kind.");
      setTitle(cleanTitle(patch.title));
    }
    return change;
  }

  const kind = kindOfEdit(current, patch);
  const structuredData = parseBrainFields(kind, patch.fields);
  const sorting = isLegacyBrainItem(current);
  if (sorting && patch.kind !== undefined) change.kind = kind;
  if (BRAIN_FIELDS[kind].titleField !== undefined || patch.title !== undefined) setTitle(titleOf(kind, structuredData, patch.title));

  const sameFields = !sorting && sameBrainFields(current.structuredData as BrainFields, structuredData);
  if (!sameFields) change.version = { structuredData, content: renderBrainContent(kind, structuredData) };
  return change;
}
