import { createHash } from "node:crypto";

/**
 * The key a vendor answer is stored and found under: the provider, the action and the inputs, with case and outer
 * space folded away so "Ada@Acme.com " and "ada@acme.com" are one lookup. Only the hash is stored.
 */
export function lookupKey(providerKey: string, actionKey: string, inputs: Record<string, unknown>): string {
  const fold = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : value);
  const sorted = Object.keys(inputs)
    .sort()
    .map((key) => [key, fold(inputs[key])]);
  return createHash("sha256").update(JSON.stringify([providerKey, actionKey, sorted])).digest("hex");
}
