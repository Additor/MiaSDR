export interface StoredWebhookStatus {
  at: string;
  hooks: Array<{ name: string; status: "registered" | "failed"; error?: string }>;
}

/** The badge on the connection card: "2 registered", "Registration failed" or "Not registered". */
export function webhookBadge(status: StoredWebhookStatus | null): { label: string; variant: "secondary" | "destructive" | "outline" } {
  if (!status || status.hooks.length === 0) return { label: "Not registered", variant: "outline" };
  const registered = status.hooks.filter((h) => h.status === "registered").length;
  if (registered < status.hooks.length) return { label: "Registration failed", variant: "destructive" };
  return { label: `${registered} registered`, variant: "secondary" };
}
