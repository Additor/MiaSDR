/**
 * The active organization lives on the session, which every tab shares. A tab still showing organization A, after another
 * tab switched to B, would write into B with nothing to tell it apart. So the browser names the organization its page was
 * rendered for, and `withActor` refuses a request whose session has moved on.
 */
export const ORGANIZATION_HEADER = "x-miasdr-organization";

/** The refusal's code. The browser owns its words (`CLIENT_MESSAGES` in `./api-client.ts`). */
export const ORGANIZATION_CHANGED = "organization_changed";
