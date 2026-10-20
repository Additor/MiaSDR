/** Pure form logic of the deal dialogs: stage choices, the request body and readiness. */

/** A stage as `GET /api/deal-stages` lists it. `id` is null for a default stage of an organization that has none yet. */
export interface DealStageOption {
  id: string | null;
  name: string;
  kind: "open" | "won" | "lost";
  position: number;
}

export interface DealStageList {
  /** True while the organization has no stages: the list is the defaults, and the first deal creates them. */
  virtual: boolean;
  stages: DealStageOption[];
}

export interface DealMemberOption {
  userId: string;
  name: string;
}

/** The Select value of the default stage of a virtual list, which has no id yet. The request then sends no stage. */
export const DEFAULT_STAGE = "default";
export const NO_OWNER = "none";

/**
 * Stage choices. A virtual list offers only its first open stage, the one the server picks when the request names none,
 * because the other default stages have no id to send until the first write creates them.
 */
export function stageChoices(list: DealStageList | null): Array<{ value: string; label: string; kind: DealStageOption["kind"] }> {
  if (!list) return [];
  if (list.virtual) {
    const first = list.stages.find((s) => s.kind === "open");
    return first ? [{ value: DEFAULT_STAGE, label: first.name, kind: first.kind }] : [];
  }
  return list.stages.filter((s): s is DealStageOption & { id: string } => s.id !== null).map((s) => ({ value: s.id, label: s.name, kind: s.kind }));
}

/** The first open stage, as a Select value. */
export function firstOpenChoice(list: DealStageList | null): string | null {
  return stageChoices(list).find((c) => c.kind === "open")?.value ?? null;
}

export interface DealFieldValues {
  title: string;
  stage: string | null;
  owner: string;
  amount: string;
  currency: string;
  expectedCloseOn: string;
  lostReason: string;
}

export const initialDealFields = (title: string, currentUserId: string): DealFieldValues => ({
  title,
  stage: null,
  owner: currentUserId,
  amount: "",
  currency: "USD",
  expectedCloseOn: "",
  lostReason: "",
});

/** The request fields of `POST /api/leads/[id]/convert`, `POST /api/deals` and `POST /api/leads/convert`. */
export function dealRequestFields(values: DealFieldValues, full: boolean) {
  const stageId = values.stage && values.stage !== DEFAULT_STAGE ? values.stage : null;
  const ownerId = values.owner === NO_OWNER || values.owner === "" ? null : values.owner;
  if (!full) return { stageId, ownerId };
  const amount = values.amount.trim();
  return {
    stageId,
    ownerId,
    title: values.title.trim(),
    amount: amount === "" ? null : amount,
    currency: amount === "" ? null : values.currency,
    expectedCloseOn: values.expectedCloseOn || null,
    lostReason: values.lostReason.trim() || null,
  };
}

/** True when the form can be sent: a stage, a title in the full form, and a reason for a Lost stage. */
export function dealFieldsReady(values: DealFieldValues, list: DealStageList | null, full: boolean): boolean {
  const choice = stageChoices(list).find((c) => c.value === values.stage);
  if (!choice) return false;
  if (full && values.title.trim() === "") return false;
  if (choice.kind === "lost" && values.lostReason.trim() === "") return false;
  return true;
}

