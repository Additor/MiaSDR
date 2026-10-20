// Pure rules for the per-account LinkedIn limits editor. No I/O.

export interface LimitRule {
  min: number;
  max: number;
  /** Values above this save, with a warning. */
  safeMax: number;
  label: string;
}

/** Hard bounds match the CHECK constraints on linkedin_accounts (migration 0007). */
export const INVITE_LIMIT_RULE = { min: 1, max: 100, safeMax: 30, label: "Invitations per day" } as const satisfies LimitRule;
export const MESSAGE_LIMIT_RULE = { min: 1, max: 200, safeMax: 100, label: "Messages per day" } as const satisfies LimitRule;
/** A free account has a far smaller weekly invitation allowance. */
export const FREE_INVITE_SAFE_MAX = 10;
export const DEFAULT_MESSAGE_LIMIT = 50;

/** Null when the value is a whole number inside the hard bounds. */
export function limitProblem(rule: LimitRule, value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < rule.min || value > rule.max) {
    return `${rule.label} is a whole number from ${rule.min} to ${rule.max}.`;
  }
  return null;
}

/** Text shown when a value is inside the bounds but past what LinkedIn tolerates. */
export function inviteLimitWarning(value: number, isPremium: boolean): string | null {
  const safe = isPremium ? INVITE_LIMIT_RULE.safeMax : FREE_INVITE_SAFE_MAX;
  if (value <= safe) return null;
  return isPremium
    ? `LinkedIn restricts accounts that send much more than ${safe} invitations a day.`
    : `A free account has a small weekly invitation allowance. More than ${safe} a day uses it up fast.`;
}

export function messageLimitWarning(value: number): string | null {
  return value > MESSAGE_LIMIT_RULE.safeMax
    ? `More than ${MESSAGE_LIMIT_RULE.safeMax} messages a day from one account looks automated and can get it restricted.`
    : null;
}

export function limitWarnings(input: { dailyInviteLimit: number; dailyMessageLimit: number; isPremium: boolean }): string[] {
  return [inviteLimitWarning(input.dailyInviteLimit, input.isPremium), messageLimitWarning(input.dailyMessageLimit)].filter((w): w is string => w !== null);
}

/** Whether another message fits today. The count includes claims in flight and unknown outcomes. */
export function messageBlock(sentToday: number, dailyLimit: number): "daily_limit" | null {
  return sentToday >= dailyLimit ? "daily_limit" : null;
}
