import { addBrainItem, changeBrainItem } from "@/contexts/brain/application/brain-items";
import { writeBrainField, type BrainFields } from "@/contexts/brain/domain/brain-fields";
import { isBrainItemKind, type BrainItemKind } from "@/contexts/brain/domain/brain-kinds";
import { aiIsOn, aiOffMessage, type AiStatus } from "@/contexts/integrations/domain/ai-status";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isUuid } from "@/shared/uuid";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { formatCount } from "@/shared/format-number";
import { FIT_MAX_PEOPLE, FIT_RUN_TOKENS, MIA_MAX_INPUT_CHARS, MIA_RUN_TOKENS } from "../domain/mia-run";
import { backgroundTokenLimit, MIN_DAILY_TOKENS_FOR_A_JOB, nextUtcMidnight, parseMiaSettingsPatch, type MiaSettings } from "../domain/mia-settings";
import { parsePageUrl } from "../domain/page-url";
import { checkConfirmed, suggestionRows, type SuggestionRow } from "../domain/suggestion";
import type { FitBatchRow, MiaBrainPort, MiaLeadPort, MiaRunStore, MiaSettingsStore, MiaSuggestionStore, RunRow } from "./mia-ports";

export interface MiaDeps {
  runs: MiaRunStore;
  suggestions: MiaSuggestionStore;
  settings: MiaSettingsStore;
  brain: MiaBrainPort;
  leads: Pick<MiaLeadPort, "existing">;
  aiStatus: (organizationId: string) => Promise<AiStatus>;
  installEnabled: () => boolean;
  now: () => Date;
  kick: () => void;
}

/** Why Mia cannot take new work here, in a person's words, or null when it can. */
export async function miaUnavailable(deps: { settings: Pick<MiaSettingsStore, "read">; aiStatus: MiaDeps["aiStatus"]; installEnabled: () => boolean }, actor: Actor): Promise<string | null> {
  if (!deps.installEnabled()) return "Mia is off on this install. The server administrator turns it on with MIA_ENABLED.";
  const settings = await deps.settings.read(actor.organizationId);
  if (!settings.enabled) return isOwnerOrAdmin(actor.role) ? "Mia is off. Turn it on in Settings, Organization." : "Mia is off. An owner or admin turns it on in Settings, Organization.";
  const status = await deps.aiStatus(actor.organizationId);
  return aiIsOn(status) ? null : (aiOffMessage(status, isOwnerOrAdmin(actor.role) ? "admin" : "member") ?? "AI is off.");
}

async function assertCanStart(deps: MiaDeps, actor: Actor): Promise<void> {
  const reason = await miaUnavailable(deps, actor);
  if (reason) throw new ConflictError(reason, { code: "mia_off" });
  const settings = await deps.settings.read(actor.organizationId);
  if (settings.dailyTokenLimit < MIN_DAILY_TOKENS_FOR_A_JOB) {
    throw new ConflictError(`The daily limit is too low for one job. An owner or admin raises it to at least ${MIN_DAILY_TOKENS_FOR_A_JOB.toLocaleString("en-US")} under Settings, Organization.`, { code: "mia_daily_limit" });
  }
  const now = deps.now();
  // A run that could not finish inside what is left would stop halfway, so it waits for a person to try again tomorrow.
  if ((await deps.runs.usedToday(actor.organizationId, now)) + MIA_RUN_TOKENS > backgroundTokenLimit(settings)) {
    const retryAfterSeconds = Math.ceil((nextUtcMidnight(now).getTime() - now.getTime()) / 1000);
    throw new ConflictError("Mia has used today's tokens. It can start this again after midnight UTC, or an owner or admin raises the limit.", { code: "mia_daily_limit", retryAfterSeconds });
  }
}

export type FillInput = { url: string } | { text: string };

export async function startBrainFill(deps: MiaDeps, actor: Actor, input: FillInput): Promise<{ id: string }> {
  let run;
  if ("url" in input) {
    const url = parsePageUrl(input.url);
    if (!url) throw new ValidationError("Enter a public https address, such as https://example.com.");
    run = { capability: "brain_fill_url" as const, input: { url: url.href } };
  } else {
    const text = input.text.trim();
    if (text === "") throw new ValidationError("Paste the text Mia should read.");
    if (text.length > MIA_MAX_INPUT_CHARS) throw new ValidationError(`The text must be at most ${MIA_MAX_INPUT_CHARS.toLocaleString("en-US")} characters.`);
    run = { capability: "brain_fill_text" as const, input: { text } };
  }
  await assertCanStart(deps, actor);
  const created = await deps.runs.create(actor.organizationId, { ...run, requestedBy: actor.userId });
  deps.kick();
  return created;
}

export async function startSort(deps: MiaDeps, actor: Actor, itemId: string): Promise<{ id: string }> {
  const doc = isUuid(itemId) ? await deps.brain.legacyDocument(actor.organizationId, itemId) : null;
  if (!doc) throw new NotFoundError("This document is sorted already, or it is gone.");
  await assertCanStart(deps, actor);
  const created = await deps.runs.create(actor.organizationId, { capability: "brain_sort", requestedBy: actor.userId, input: { itemId } });
  deps.kick();
  return created;
}

export async function cancelRun(deps: Pick<MiaDeps, "runs" | "now">, actor: Actor, id: string): Promise<void> {
  const found = isUuid(id) && (await deps.runs.requestCancel(actor.organizationId, id, actor.userId, deps.now()));
  if (!found) throw new NotFoundError("This job already ended.");
}

export const recentRuns = (deps: Pick<MiaDeps, "runs" | "now">, actor: Actor): Promise<RunRow[]> => deps.runs.recent(actor.organizationId, deps.now());

export const MIA_SUGGESTIONS_PAGE = 50;

export interface SuggestionView {
  id: string;
  type: "new_item" | "item_change";
  kind: BrainItemKind;
  title: string;
  /** A document from before the kinds existed: the old text stays as an earlier version. */
  sorting: boolean;
  /** The item this changes. Null for a new one. */
  targetItemId: string | null;
  /** That item's revision now. Accepting sends it back, so an edit made after the form opened is not undone. */
  revision: number | null;
  /** The fields it sets, beside what the item holds now. */
  rows: SuggestionRow[];
  /** The whole item as Mia would leave it, for the form to start from. */
  fields: BrainFields;
  createdAt: Date;
}

/** How many wait for a person, for a view that shows the number and not the list. */
export const openSuggestionCount = (deps: Pick<MiaDeps, "suggestions">, actor: Actor): Promise<number> => deps.suggestions.countOpen(actor.organizationId);

/** Open suggestions with what each would change. A suggestion whose kind this install no longer has stays out. */
export async function openSuggestions(deps: Pick<MiaDeps, "suggestions" | "brain">, actor: Actor): Promise<{ rows: SuggestionView[]; total: number }> {
  const [stored, total] = await Promise.all([deps.suggestions.listOpen(actor.organizationId, MIA_SUGGESTIONS_PAGE), deps.suggestions.countOpen(actor.organizationId)]);
  const rows = await Promise.all(
    stored.map(async (item): Promise<SuggestionView | null> => {
      if (!isBrainItemKind(item.kind)) return null;
      const current = item.targetItemId ? await deps.brain.currentFields(actor.organizationId, item.targetItemId) : null;
      const fields: BrainFields = structuredClone(current?.fields ?? {});
      for (const [key, field] of Object.entries(item.payload.fields)) writeBrainField(fields, key, field.value);
      const rowsOf = suggestionRows(item.kind, item.payload, current?.fields ?? null);
      return { id: item.id, type: item.type, kind: item.kind, title: item.title, sorting: item.payload.sorting, targetItemId: item.targetItemId, revision: current?.revision ?? null, rows: rowsOf, fields, createdAt: item.createdAt };
    }),
  );
  return { rows: rows.filter((row) => row !== null), total };
}

export interface AcceptInput {
  fields: BrainFields;
  /** Unverified fields the person checked against the source. */
  confirmed?: string[];
  /** Only for a kind without a title field. */
  title?: string;
  /** The revision of the item the person compared with. Needed when the suggestion changes an item. */
  revision?: number;
}

/** Saves a suggestion as a person left it, through the same rules, versions and audit as a person's own edit. */
export async function acceptSuggestion(deps: Pick<MiaDeps, "suggestions" | "now">, actor: Actor, id: string, input: AcceptInput): Promise<{ itemId: string }> {
  let itemId = "";
  const found =
    isUuid(id) &&
    (await deps.suggestions.decide(actor.organizationId, id, actor.userId, deps.now(), async (suggestion, brain) => {
      if (suggestion.status !== "open") throw new ConflictError("Someone already decided this suggestion.", { code: "mia_decided" });
      if (!isBrainItemKind(suggestion.kind)) throw new ValidationError("Unknown item kind.");
      checkConfirmed(suggestion.kind, suggestion.payload, input.fields, input.confirmed ?? []);
      if (suggestion.type === "new_item") {
        const created = await addBrainItem(brain, actor, { kind: suggestion.kind, fields: input.fields, ...(input.title === undefined ? {} : { title: input.title }) });
        itemId = created.id;
        return { status: "accepted", createdItemId: created.id };
      }
      if (!suggestion.targetItemId || input.revision === undefined) throw new ConflictError("The item this suggestion changes is gone. Dismiss it.", { code: "mia_target_gone" });
      await changeBrainItem(brain, actor, suggestion.targetItemId, {
        fields: input.fields,
        revision: input.revision,
        ...(suggestion.payload.sorting ? { kind: suggestion.kind } : {}),
        ...(input.title === undefined ? {} : { title: input.title }),
      });
      itemId = suggestion.targetItemId;
      return { status: "accepted" };
    }));
  if (!found) throw new NotFoundError("Suggestion not found");
  return { itemId };
}

export async function dismissSuggestion(deps: Pick<MiaDeps, "suggestions" | "now">, actor: Actor, id: string): Promise<void> {
  const found =
    isUuid(id) &&
    (await deps.suggestions.decide(actor.organizationId, id, actor.userId, deps.now(), async (suggestion) => {
      if (suggestion.status !== "open") throw new ConflictError("Someone already decided this suggestion.", { code: "mia_decided" });
      return { status: "dismissed" };
    }));
  if (!found) throw new NotFoundError("Suggestion not found");
}

export const getMiaSettings = (deps: Pick<MiaDeps, "settings">, actor: Actor): Promise<MiaSettings> => deps.settings.read(actor.organizationId);

export async function updateMiaSettings(deps: Pick<MiaDeps, "settings">, actor: Actor, raw: { enabled?: unknown; dailyTokenLimit?: unknown }): Promise<MiaSettings> {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can change Mia's settings.");
  return deps.settings.save(actor.organizationId, actor.userId, parseMiaSettingsPatch(raw));
}

/**
 * Queues a fit check for each of these leads, at most FIT_MAX_PEOPLE. It starts only when today's tokens cover every
 * check, so a batch never stops halfway for the limit it was shown, and it says how many would fit.
 */
export async function startFitCheck(deps: MiaDeps, actor: Actor, raw: unknown): Promise<{ batchId: string; queued: number; skipped: number }> {
  const ids = Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === "string" && isUuid(id)))] : [];
  if (ids.length === 0) throw new ValidationError("Pick at least one lead.");
  if (ids.length > FIT_MAX_PEOPLE) throw new ValidationError(`Check up to ${FIT_MAX_PEOPLE} leads at a time.`);
  const reason = await miaUnavailable(deps, actor);
  if (reason) throw new ConflictError(reason, { code: "mia_off" });
  if (!(await hasIcp(deps, actor))) throw new ConflictError(NO_ICP, { code: "mia_no_icp" });
  const personIds = await deps.leads.existing(actor.organizationId, ids);
  if (personIds.length === 0) throw new NotFoundError("These leads are gone.");
  const room = await fitRoom(deps, actor);
  if (personIds.length > room.people) {
    const now = deps.now();
    const retryAfterSeconds = Math.ceil((nextUtcMidnight(now).getTime() - now.getTime()) / 1000);
    const fits = room.people === 0 ? "no more checks today" : `${formatCount(room.people)} ${room.people === 1 ? "lead" : "leads"}`;
    throw new ConflictError(`Today's tokens cover ${fits}. Pick fewer, or try again after midnight UTC.`, { code: "mia_daily_limit", retryAfterSeconds });
  }
  const created = await deps.runs.createFitRuns(actor.organizationId, { requestedBy: actor.userId, personIds });
  deps.kick();
  return created;
}

const NO_ICP = "Brain has no active ICP to check against. Add one under Brain, Market.";

const hasIcp = (deps: Pick<MiaDeps, "brain">, actor: Actor) => deps.brain.hasActiveIcp(actor.organizationId);

/** Why a fit check cannot start here, in a person's words, or null when it can. */
export async function fitUnavailable(deps: Pick<MiaDeps, "settings" | "aiStatus" | "installEnabled" | "brain">, actor: Actor): Promise<string | null> {
  return (await miaUnavailable(deps, actor)) ?? ((await hasIcp(deps, actor)) ? null : NO_ICP);
}

/**
 * How many fit checks today's tokens still cover, and what one check may cost. Checks and jobs that are queued or running
 * hold their budget, so a second batch cannot spend what the first was shown.
 */
export async function fitRoom(deps: Pick<MiaDeps, "settings" | "runs" | "now">, actor: Actor): Promise<{ people: number; perLead: number; tokensLeft: number }> {
  const [settings, used, reserved] = await Promise.all([deps.settings.read(actor.organizationId), deps.runs.usedToday(actor.organizationId, deps.now()), deps.runs.reservedTokens(actor.organizationId)]);
  const tokensLeft = Math.max(0, backgroundTokenLimit(settings) - used - reserved);
  return { people: Math.min(FIT_MAX_PEOPLE, Math.floor(tokensLeft / FIT_RUN_TOKENS)), perLead: FIT_RUN_TOKENS, tokensLeft };
}

export const latestFitBatch = (deps: Pick<MiaDeps, "runs" | "now">, actor: Actor): Promise<FitBatchRow | null> => deps.runs.latestFitBatch(actor.organizationId, deps.now());

export async function cancelFitBatch(deps: Pick<MiaDeps, "runs" | "now">, actor: Actor, batchId: string): Promise<void> {
  const found = isUuid(batchId) && (await deps.runs.cancelFitBatch(actor.organizationId, batchId, actor.userId, deps.now()));
  if (!found) throw new NotFoundError("This check already ended.");
}

export const miaUsedToday =(deps: Pick<MiaDeps, "runs" | "now">, actor: Actor): Promise<number> => deps.runs.usedToday(actor.organizationId, deps.now());
