import { PERSONAL_CAMPAIGN_MESSAGE } from "@/contexts/people/application/convert-to-contact";
import { sqlState } from "@/platform/db/errors";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { parseCloseDate, parseDealTitle } from "../domain/deal";
import { parseAmountToMinor, parseCurrency } from "../domain/money";
import { firstOpenStage } from "../domain/stages";
import type { DealPerson, DealsDeps, DealStage } from "./deal-ports";

export const MAX_BULK_CONVERT_IDS = 200;
/** The time one bulk request spends on conversions; the ids it did not reach come back `retryable`. */
export const BULK_TIME_BUDGET_MS = 20_000;
export const BOARD_LIMIT = 25;
export const MAX_BOARD_LIMIT = 100;
export const CLOSED_WINDOW_DAYS = 30;
export const CRM_PAGE_SIZE = 25;
export const MAX_IDEMPOTENCY_KEY = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** The constraint a 23503 or 23505 names (`constraint_name` from the driver, also under a wrapping error's `cause`). */
export function violatedConstraint(error: unknown, code: "23503" | "23505"): string | null {
  if (sqlState(error) !== code) return null;
  let current = error as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current.constraint_name === "string") return current.constraint_name;
    current = current.cause as typeof current;
  }
  return null;
}

/** The person has a live enrollment in another member's personal campaign. */
export class PersonalCampaignError extends ForbiddenError {
  readonly code = "personal_campaign";
  constructor() {
    super(PERSONAL_CAMPAIGN_MESSAGE);
  }
}

export const isAlreadyConverted = (error: unknown) => error instanceof ConflictError && error.details?.code === "already_converted";

// ---- Input ---------------------------------------------------------------------------------------------------

export interface CreateDealInput {
  title?: string | null;
  stageId?: string | null;
  /** Omitted: the actor. Null: no owner. */
  ownerId?: string | null;
  /** As typed ("1,250.50") or a number, in major units of `currency`. */
  amount?: string | number | null;
  currency?: string | null;
  expectedCloseOn?: string | null;
  /** Needed when `stageId` names a Lost stage. */
  lostReason?: string | null;
  /** One per dialog open. A repeat with the same key replays the first result. */
  idempotencyKey?: string | null;
}

export interface DealFields {
  title: string | null;
  stageId: string | null;
  ownerUserId: string | null;
  amountMinor: number | null;
  currency: string | null;
  expectedCloseOn: string | null;
  lostReason: string | null | undefined;
  idempotencyKey: string | null;
}

export function parseMoney(amount: string | number | null | undefined, currency: string | null | undefined): { amountMinor: number | null; currency: string | null } {
  if (amount === null || amount === undefined || (typeof amount === "string" && amount.trim() === "")) return { amountMinor: null, currency: null };
  if (!currency) throw new ValidationError("Pick the currency of the amount.");
  const code = parseCurrency(currency);
  return { amountMinor: parseAmountToMinor(amount, code), currency: code };
}

function parseKey(key: string | null | undefined): string | null {
  if (key === null || key === undefined) return null;
  const value = key.trim();
  if (value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY) throw new ValidationError(`Send an idempotency key of 1 to ${MAX_IDEMPOTENCY_KEY} characters.`);
  return value;
}

export async function assertOwner(deps: DealsDeps, actor: Actor, ownerId: string | null): Promise<void> {
  if (ownerId === null) return;
  if (!isUuid(ownerId) || !(await deps.members.isMember(actor.organizationId, ownerId))) throw new ValidationError("The owner must be a member of this organization.");
}

export async function parseDealFields(deps: DealsDeps, actor: Actor, input: CreateDealInput): Promise<DealFields> {
  const title = input.title === undefined || input.title === null || input.title.trim() === "" ? null : parseDealTitle(input.title);
  const stageId = input.stageId ?? null;
  if (stageId !== null && !isUuid(stageId)) throw new ValidationError("Pick a stage of this pipeline.");
  const ownerUserId = input.ownerId === undefined ? actor.userId : input.ownerId;
  const money = parseMoney(input.amount, input.currency);
  const expectedCloseOn = parseCloseDate(input.expectedCloseOn);
  const idempotencyKey = parseKey(input.idempotencyKey);
  await assertOwner(deps, actor, ownerUserId);
  return { title, stageId, ownerUserId, ...money, expectedCloseOn, lostReason: input.lostReason, idempotencyKey };
}

export function pickStage(stages: DealStage[], stageId: string | null): DealStage {
  const stage = stageId ? stages.find((s) => s.id === stageId) : firstOpenStage(stages);
  if (!stage) throw new ValidationError("Pick a stage of this pipeline.");
  return stage;
}

export async function personOf(deps: DealsDeps, actor: Actor, personId: string, what: string): Promise<DealPerson> {
  if (!isUuid(personId)) throw new NotFoundError(`${what} not found`);
  const person = (await deps.people.summaries(actor.organizationId, [personId])).get(personId);
  if (!person) throw new NotFoundError(`${what} not found`);
  return person;
}
