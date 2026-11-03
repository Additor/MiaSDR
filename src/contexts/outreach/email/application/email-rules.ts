import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, ValidationError, type Actor } from "@/shared/errors";
import { emailRules, postalAddressProblem, senderPostalAddress, sendGapProblem, takeoverHoursProblem } from "../../domain/send-policy";
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
  senderPostalAddress: string | null;
}

export async function getEmailRules(deps: EmailRulesDeps, actor: Actor): Promise<EmailRulesView> {
  const [email, general] = await Promise.all([deps.settings.get(actor.organizationId, "email"), deps.settings.get(actor.organizationId, "general")]);
  const zone = general?.timeZone;
  return {
    ...emailRules(email),
    senderPostalAddress: senderPostalAddress(email),
    timeZone: (typeof zone === "string" ? canonicalTimeZone(zone) : null) ?? "UTC",
  };
}

/** The pace, the takeover delay and the postal address. The view shows the organization's zone, which Settings > Organization (tenancy) owns. */
export async function updateEmailRules(
  deps: EmailRulesDeps,
  actor: Actor,
  input: { minGapMinutes: number; maxGapMinutes: number; takeoverAfterHours?: number; senderPostalAddress?: string },
): Promise<EmailRulesView> {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can change email rules.");
  const problem = sendGapProblem(input.minGapMinutes, input.maxGapMinutes);
  if (problem) throw new ValidationError(problem);
  if (input.takeoverAfterHours !== undefined) {
    const hoursProblem = takeoverHoursProblem(input.takeoverAfterHours);
    if (hoursProblem) throw new ValidationError(hoursProblem);
  }
  // Blank stays allowed only while nothing is stored, so a running campaign can never lose its footer's address.
  const address = input.senderPostalAddress?.trim();
  const storedAddress = address === undefined ? null : senderPostalAddress(await deps.settings.get(actor.organizationId, "email"));
  if (address !== undefined && (address !== "" || storedAddress !== null)) {
    const addressProblem = postalAddressProblem(address);
    if (addressProblem) throw new ValidationError(addressProblem);
  }
  await deps.settings.merge(
    actor.organizationId,
    "email",
    {
      sendGapMinutes: [input.minGapMinutes, input.maxGapMinutes],
      ...(input.takeoverAfterHours !== undefined ? { takeoverAfterHours: input.takeoverAfterHours } : {}),
      ...(address ? { senderPostalAddress: address } : {}),
    },
    actor.userId,
  );
  return getEmailRules(deps, actor);
}
