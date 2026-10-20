/** Where the full text lives. The repository has no public URL the app can link to, so the note names the file. */
export const RESPONSIBLE_USE_DOC = "docs/responsible-use.md";

export const RESPONSIBLE_USE_TEXT = {
  launch: "You are responsible for consent and for following the laws that cover your recipients, such as CAN-SPAM, GDPR and CASL. LinkedIn campaigns must also follow LinkedIn's terms.",
  linkedin: "LinkedIn's terms prohibit automated activity, and LinkedIn can restrict or ban an account that sends invitations and messages this way.",
} as const;

/** One-line warning shown where a campaign starts and where LinkedIn accounts connect. */
export function ResponsibleUseNote({ kind }: { kind: keyof typeof RESPONSIBLE_USE_TEXT }) {
  return (
    <p role="note" data-testid="responsible-use-note" className="max-w-prose text-xs text-muted-foreground">
      {RESPONSIBLE_USE_TEXT[kind]} Before you start, read <code>{RESPONSIBLE_USE_DOC}</code>.
    </p>
  );
}
