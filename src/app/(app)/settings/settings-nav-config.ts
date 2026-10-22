export interface SettingsItem {
  href: string;
  /** Page title, also the nav label. */
  title: string;
  /** One line on the /settings overview. */
  summary: string;
  /** Hidden from members; the page itself refuses them. */
  adminOnly?: boolean;
}

export interface SettingsGroup {
  label: string;
  items: SettingsItem[];
}

/**
 * Groups follow what a setting changes: the workspace and its keys, how outreach sends, the CRM's data model, what the
 * AI does, and the operations an admin checks when something failed. Each setting has one home.
 */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/settings/organization", title: "Organization", summary: "Rename the organization and set its default time zone and phone country." },
      { href: "/settings/members", title: "Members", summary: "Invite people, change roles and remove members." },
      { href: "/settings/integrations", title: "Integrations", summary: "API keys for the AI provider and the enrichment providers. Keys are stored encrypted.", adminOnly: true },
    ],
  },
  {
    label: "Sending",
    items: [
      { href: "/settings/mailboxes", title: "Mailboxes", summary: "Connect the addresses campaigns send from, set their limits, hours and signatures, and the pace between sends." },
      { href: "/settings/linkedin", title: "LinkedIn", summary: "Connect LinkedIn accounts through Unipile and set their daily limits." },
    ],
  },
  {
    label: "CRM",
    items: [
      { href: "/settings/pipeline", title: "Pipeline stages", summary: "Rename, reorder, add and delete the stages deals move through." },
      { href: "/settings/columns", title: "Custom fields", summary: "Add, rename, reorder, archive or delete the fields on people and companies." },
    ],
  },
  {
    label: "AI",
    items: [
      { href: "/settings/replies", title: "Reply handling", summary: "Reply categories, how much the AI may decide alone, and its daily limit for unknown senders." },
      { href: "/settings/instructions", title: "AI instructions", summary: "What the AI is told when it classifies a reply and when it drafts one." },
      { href: "/settings/knowledge", title: "Knowledge", summary: "Paste text the AI can use when it drafts replies." },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/settings/jobs", title: "Jobs", summary: "Failed and skipped AI jobs, background failures and recent runs.", adminOnly: true },
      { href: "/settings/inbound-events", title: "Inbound events", summary: "Gmail messages and LinkedIn deliveries that failed: replay, retry or dismiss them.", adminOnly: true },
    ],
  },
];

export function visibleGroups(isAdmin: boolean): SettingsGroup[] {
  return SETTINGS_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => isAdmin || !i.adminOnly) })).filter((g) => g.items.length > 0);
}

export function findSettingsItem(pathname: string): SettingsItem | undefined {
  return SETTINGS_GROUPS.flatMap((g) => g.items).find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
}
