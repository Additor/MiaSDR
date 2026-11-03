/** Reads the TXT records of one host, in the shape `node:dns` answers: each record as its chunks. */
export type ResolveTxt = (host: string) => Promise<string[][]>;

/** `unchecked` means the lookup failed, so nothing is known about the record. */
export type DnsRecordState = "found" | "missing" | "unchecked";

export interface SenderDnsResult {
  domain: string;
  spf: DnsRecordState;
  dkim: DnsRecordState;
  dmarc: DnsRecordState;
}

/** The selector Google Workspace suggests. Another provider, or a custom prefix, publishes under another name. */
export const DKIM_SELECTOR = "google";

/** The codes that mean DNS answered: the name or its TXT records do not exist. Any other failure says nothing about the record. */
const NO_RECORD_CODES = new Set(["ENODATA", "ENOTFOUND"]);

async function lookup(resolveTxt: ResolveTxt, host: string, matches: (record: string) => boolean): Promise<DnsRecordState> {
  try {
    const records = await resolveTxt(host);
    return records.some((chunks) => matches(chunks.join("").trim())) ? "found" : "missing";
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && NO_RECORD_CODES.has(code) ? "missing" : "unchecked";
  }
}

export const domainOfAddress = (address: string): string => address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase();

/** Looks up SPF, DKIM on the `google` selector and DMARC for one domain. It reads public DNS and decides nothing else. */
export async function checkSenderDomain(resolveTxt: ResolveTxt, domain: string): Promise<SenderDnsResult> {
  const [spf, dkim, dmarc] = await Promise.all([
    lookup(resolveTxt, domain, (record) => /^v=spf1(\s|$)/i.test(record)),
    lookup(resolveTxt, `${DKIM_SELECTOR}._domainkey.${domain}`, (record) => /(^|;)\s*p=[^;\s]/i.test(record)),
    lookup(resolveTxt, `_dmarc.${domain}`, (record) => /^v=DMARC1(\s*;|$)/i.test(record)),
  ]);
  return { domain, spf, dkim, dmarc };
}

/** One result per domain among the mailboxes' addresses, in the order the domains first appear. */
export function checkSenderDomains(resolveTxt: ResolveTxt, addresses: readonly string[]): Promise<SenderDnsResult[]> {
  const domains = [...new Set(addresses.map(domainOfAddress).filter((domain) => domain !== ""))];
  return Promise.all(domains.map((domain) => checkSenderDomain(resolveTxt, domain)));
}
