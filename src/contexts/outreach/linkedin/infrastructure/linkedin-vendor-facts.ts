/** What the stores must know about each LinkedIn vendor, so they name no vendor themselves. */
const VENDOR_FACTS: Record<string, { credentialFields: readonly string[]; readByPoll: boolean }> = {
  unipile: { credentialFields: ["dsn", "apiKey"], readByPoll: false },
  edges: { credentialFields: ["apiKey"], readByPoll: true },
};

/** The vendors' rows in the integration tables. */
export const VENDOR_KEYS = Object.keys(VENDOR_FACTS);

/** The fields a vendor must have stored to count as connected. */
export const credentialFieldsOf = (key: string): readonly string[] => VENDOR_FACTS[key]?.credentialFields ?? [];

/** Vendors with no webhook for messages. A job reads their accounts' inboxes, and a claim checks that the read is recent. */
export const VENDORS_READ_BY_POLL = VENDOR_KEYS.filter((key) => VENDOR_FACTS[key].readByPoll);
