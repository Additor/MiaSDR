/** What the stores must know about each LinkedIn vendor, so they name no vendor themselves. */
const VENDOR_FACTS: Record<string, { credentialFields: readonly string[]; readByPoll: boolean; inviteLimitCap?: number; capturesOnlyLaterEvents?: boolean }> = {
  unipile: { credentialFields: ["dsn", "apiKey"], readByPoll: false },
  edges: { credentialFields: ["apiKey"], readByPoll: true },
  // gtm-api's own daily budget for invitations is 25 on a paid account, and each refusal holds invitations until it refills.
  gtmapi: { credentialFields: ["apiKey"], readByPoll: true, inviteLimitCap: 20 },
  linkedapi: { credentialFields: ["apiKey"], readByPoll: true, capturesOnlyLaterEvents: true },
};

/** The vendors' rows in the integration tables. */
export const VENDOR_KEYS = Object.keys(VENDOR_FACTS);

/** The fields a vendor must have stored to count as connected. */
export const credentialFieldsOf = (key: string): readonly string[] => VENDOR_FACTS[key]?.credentialFields ?? [];

/** Vendors with no webhook for messages. A job reads their accounts' inboxes, and a claim checks that the read is recent. */
export const VENDORS_READ_BY_POLL = VENDOR_KEYS.filter((key) => VENDOR_FACTS[key].readByPoll);

/** A vendor that starts capturing an account's events again only after a reconnect, so what happened during it is lost to a read. */
export const capturesOnlyLaterEvents = (key: string): boolean => VENDOR_FACTS[key]?.capturesOnlyLaterEvents === true;

/** The most invitations a day a new account of this vendor starts with. */
export const inviteLimitCapOf = (key: string): number => VENDOR_FACTS[key]?.inviteLimitCap ?? Number.POSITIVE_INFINITY;
