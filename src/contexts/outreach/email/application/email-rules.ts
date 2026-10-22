import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, ValidationError, type Actor } from "@/shared/errors";
import { emailRules, sendGapProblem, takeoverHoursProblem } from "../../domain/send-policy";
import { canonicalTimeZone } from "@/shared/time-zone";

/** Per-organization settings rows (`channel_settings`). Values are merged, so keys this screen does not know survive. */
export interface ChannelSettingsStore {
  get(organizationId: string, channel: string): Promise<Record<string, unknown> | null>;
  merge(organizationId: string, channel: string, patch: Record<string, unknown>, userId: string): Promise<void>;
}

export interface EmailRulesDeps {
  settings: ChannelSettingsStore;
}

export interface EmailRulesView {
  sendGapMinutes: [number, number];
  takeoverAfterHours: number;
  timeZone: string;
}

export async function getEmailRules(deps: EmailRulesDeps, actor: Actor): Promise<EmailRulesView> {
  const [email, general] = await Promise.all([deps.settings.get(actor.organizationId, "email"), deps.settings.get(actor.organizationId, "general")]);
  const zone = general?.timeZone;
  return {
    ...emailRules(email),
    timeZone: (typeof zone === "string" ? canonicalTimeZone(zone) : null) ?? "UTC",
  };
}

/** `timeZone` is optional: Settings > Organization owns it, and the Mailboxes page saves the pace without it. */
export async function updateEmailRules(
  deps: EmailRulesDeps,
  actor: Actor,
  input: { minGapMinutes: number; maxGapMinutes: number; timeZone?: string; takeoverAfterHours?: number },
): Promise<EmailRulesView> {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can change email rules.");
  const problem = sendGapProblem(input.minGapMinutes, input.maxGapMinutes);
  if (problem) throw new ValidationError(problem);
  const timeZone = input.timeZone === undefined ? undefined : canonicalTimeZone(input.timeZone);
  if (timeZone === null) throw new ValidationError("Unknown time zone.");
  if (input.takeoverAfterHours !== undefined) {
    const hoursProblem = takeoverHoursProblem(input.takeoverAfterHours);
    if (hoursProblem) throw new ValidationError(hoursProblem);
  }
  await deps.settings.merge(
    actor.organizationId,
    "email",
    { sendGapMinutes: [input.minGapMinutes, input.maxGapMinutes], ...(input.takeoverAfterHours !== undefined ? { takeoverAfterHours: input.takeoverAfterHours } : {}) },
    actor.userId,
  );
  if (timeZone) await deps.settings.merge(actor.organizationId, "general", { timeZone }, actor.userId);
  return getEmailRules(deps, actor);
}
