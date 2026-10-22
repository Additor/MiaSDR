/**
 * Whether AI runs for an organization, and why not when it does not. Every screen that says AI is off reads this, so
 * a saved key with no model reads the same in onboarding, the Inbox and AI columns as on the AI model card.
 */
export type AiStatus =
  | { state: "on"; provider: string; model: string }
  /** AI_PROVIDER=fake: features answer from stand-ins and no provider is called. */
  | { state: "demo" }
  | { state: "no_key" }
  /** A key is saved for `provider`, which has no default model, and nobody picked one. */
  | { state: "no_model"; provider: string };

export const aiIsOn = (status: AiStatus): boolean => status.state === "on" || status.state === "demo";

/**
 * What stops AI and how to turn it on, as one sentence. `member` words the fix as a request, because only an owner or
 * admin can open Settings, Integrations. Null when AI is on.
 */
export function aiOffMessage(status: AiStatus, reader: "admin" | "member" = "admin"): string | null {
  if (status.state === "no_key") {
    return reader === "admin" ? "AI is off. Connect an AI provider in Settings, Integrations." : "AI is off. Ask an owner or admin to connect an AI provider.";
  }
  if (status.state === "no_model") {
    return reader === "admin"
      ? `AI is off. ${status.provider} needs a model: pick one in Settings, Integrations.`
      : `AI is off. ${status.provider} needs a model: ask an owner or admin to pick one.`;
  }
  return null;
}
