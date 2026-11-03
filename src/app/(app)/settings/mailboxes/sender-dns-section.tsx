import { StatusBadge } from "@/components/shell/status-badge";
import { checkSenderDomains, type DnsRecordState } from "@/contexts/outreach/email/application/sender-dns";
import { resolveTxtRecords } from "@/contexts/outreach/infrastructure/composition";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

const STATE_LABEL: Record<DnsRecordState, string> = { found: "Found", missing: "Missing", unchecked: "Could not check" };

const DESCRIPTION = (
  <>
    Inbox providers look for these DNS entries on the domain you send from. This check reads public DNS and never stops a send. <code>docs/guides/sender-dns.md</code> has the values for Google Workspace.
  </>
);

function DnsEntry({ name, state }: { name: string; state: DnsRecordState }) {
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={`dns-${name.toLowerCase()}`}>
      {name} <StatusBadge status={state} label={STATE_LABEL[state]} />
    </span>
  );
}

/** While the lookups run, the page shows the block's frame, so the mailboxes above do not wait for DNS. */
export function SenderDnsFallback() {
  return (
    <SettingsSection title="Sender DNS" description={DESCRIPTION}>
      <p className="text-sm text-muted-foreground">Checking DNS…</p>
    </SettingsSection>
  );
}

/** SPF, DKIM and DMARC for each domain the organization's mailboxes send from. */
export async function SenderDnsSection({ addresses }: { addresses: string[] }) {
  const results = await checkSenderDomains(resolveTxtRecords, addresses);
  return (
    <SettingsSection title="Sender DNS" description={DESCRIPTION} testId="sender-dns">
      <ul className={RULED_LIST}>
        {results.map((result) => (
          <li key={result.domain} className={`${RULED_ROW} stack-field text-sm`} data-testid="sender-dns-domain">
            <p className="font-medium">{result.domain}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <DnsEntry name="SPF" state={result.spf} />
              <DnsEntry name="DKIM" state={result.dkim} />
              <DnsEntry name="DMARC" state={result.dmarc} />
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">DKIM reads the google._domainkey selector only. Another provider or a custom prefix uses another selector, so a domain can sign its mail even when this says Missing.</p>
    </SettingsSection>
  );
}
