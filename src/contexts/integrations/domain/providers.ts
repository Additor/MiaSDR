export interface ProviderField {
  name: string;
  label: string;
}

export interface ProviderSpec {
  key: string;
  /** Matches `integration_accounts.kind`. */
  kind: "enrichment" | "platform" | "ai";
  label: string;
  description: string;
  /** Every field is secret and stored encrypted. */
  fields: ProviderField[];
}

/** Providers this screen manages. Add one here and the form, the validation and the list pick it up. */
export const MANAGED_PROVIDERS: ProviderSpec[] = [
  {
    key: "anthropic",
    kind: "ai",
    label: "Anthropic",
    description: "API key for reply classification and drafts.",
    fields: [{ name: "apiKey", label: "API key" }],
  },
];

/** Providers with their own settings page. They are listed here but never edited here. */
export const EXTERNAL_PROVIDERS: Record<string, { label: string; href: string }> = {
  unipile: { label: "Unipile (LinkedIn)", href: "/settings/linkedin" },
};

export function managedProvider(key: string): ProviderSpec | undefined {
  return MANAGED_PROVIDERS.find((p) => p.key === key);
}

const MAX_SECRET_LENGTH = 2000;

export type CredentialInput = { ok: true; values: Record<string, string> } | { ok: false; reason: string };

/** Trims every field, requires all of them, and drops anything the provider does not declare. */
export function validateCredentialInput(spec: ProviderSpec, input: Record<string, unknown>): CredentialInput {
  const values: Record<string, string> = {};
  for (const field of spec.fields) {
    const raw = input[field.name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) return { ok: false, reason: `${field.label} is required.` };
    if (value.length > MAX_SECRET_LENGTH) return { ok: false, reason: `${field.label} is too long.` };
    values[field.name] = value;
  }
  return { ok: true, values };
}
