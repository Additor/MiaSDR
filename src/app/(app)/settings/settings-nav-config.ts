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

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/settings/organization", title: "Organization", summary: "Rename the organization and set its default time zone and phone country." },
      { href: "/settings/members", title: "Members", summary: "Invite people, change roles and remove members." },
      { href: "/settings/columns", title: "Custom fields", summary: "Add, rename, reorder, archive or delete the fields on people and companies." },
    ],
  },
  {
    label: "Sending",
    items: [
      { href: "/settings/mailboxes", title: "Mailboxes", summary: "Connect the addresses campaigns send from, and set daily limits, signatures and working hours." },
      { href: "/settings/email", title: "Email rules", summary: "Set the gap between sends and when follow-ups change mailbox." },
      { href: "/settings/linkedin", title: "LinkedIn", summary: "Connect LinkedIn accounts through Unipile." },
    ],
  },
  {
    label: "CRM",
    items: [{ href: "/settings/pipeline", title: "Pipeline stages", summary: "Rename, reorder, add and delete the stages deals move through." }],
  },
  {
    label: "AI",
    items: [
      { href: "/settings/replies", title: "Replies", summary: "Reply categories, how much the AI may decide alone, and what it is told." },
      { href: "/settings/knowledge", title: "Knowledge", summary: "Paste text the AI can use when it drafts replies." },
      { href: "/settings/integrations", title: "Integrations", summary: "Connect an AI provider and pick the model AI runs on. Keys are stored encrypted.", adminOnly: true },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/settings/jobs", title: "Jobs", summary: "See recent runs, replay failed LinkedIn webhooks and reset daily counters.", adminOnly: true },
      { href: "/settings/inbound-events", title: "Inbound events", summary: "Review Gmail messages and LinkedIn deliveries that failed, then retry or dismiss them.", adminOnly: true },
    ],
  },
];

export function visibleGroups(isAdmin: boolean): SettingsGroup[] {
  return SETTINGS_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => isAdmin || !i.adminOnly) })).filter((g) => g.items.length > 0);
}

export function findSettingsItem(pathname: string): SettingsItem | undefined {
  return SETTINGS_GROUPS.flatMap((g) => g.items).find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
}
