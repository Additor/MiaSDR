import { ValidationError } from "@/shared/errors";
import { LinkedInGatewayError, type LinkedInVendor, type VendorCredentials } from "../../../application/linkedin-ports";
import { LinkedApiPlainError } from "./linkedapi-errors";
import { LinkedApiGateway, preferredAccounts } from "./linkedapi-gateway";
import { LinkedApiClient } from "./linkedapi-http";
import { obj, slugOf, str } from "./linkedapi-rows";

const NAME = "Linked API";
/** A sign-in right after the link was made may read a little earlier on Linked API's clock. */
const CONNECTED_SLACK_MS = 2 * 60_000;

function explain(error: unknown): string {
  if (error instanceof LinkedApiPlainError) return error.message;
  if (error instanceof LinkedInGatewayError) {
    if (error.code === "auth") return "Linked API rejected the token. Check the token in Linked API, or that the account is still signed in there.";
    if (error.code === "unavailable") return "Could not reach Linked API. Try again.";
    if (error.code === "rate_limited") return "Linked API refused for now: its plan or a limit. Check your Linked API workspace, or try again later.";
    return "Linked API refused the request. Check your Linked API workspace.";
  }
  return "Could not reach Linked API.";
}

const SESSION_ENDED: Record<string, string> = {
  expired: "The Linked API sign-in timed out. Make a new link.",
  cancelled: "The Linked API sign-in was cancelled. Make a new link.",
  error: "Linked API could not finish the sign-in. Make a new link.",
};

/** Everything specific to Linked API that the connection flows need. A link is a session, which names its account only once it finished. */
export function createLinkedApiVendor(options: { fetch?: typeof fetch } = {}): LinkedInVendor {
  const clientOf = (credentials: VendorCredentials) => new LinkedApiClient({ apiKey: credentials.apiKey ?? "", ...(options.fetch ? { fetch: options.fetch } : {}) });
  return {
    key: "linkedapi",
    name: NAME,
    integrationName: "Linked API (LinkedIn)",
    // A token belongs to one organization, so its accounts are this organization's.
    syncAddsAccounts: true,
    // The documents state no session lifetime. A person finishes a sign-in in minutes, and a session holds a seat.
    connectLinkMinutes: 60,
    inboundNote: "MiaSDR reads replies and acceptances from Linked API about every 10 minutes. How fresh they are depends on Linked API's own sync, whose period it does not state, and this page cannot measure.",

    readConnectInput(input) {
      const apiKey = (input.apiKey ?? "").trim();
      if (apiKey === "" || apiKey.length > 500) throw new ValidationError("Enter the Linked API token.");
      return { apiKey };
    },

    gatewayFor: (credentials) => new LinkedApiGateway({ apiKey: credentials.apiKey ?? "", ...(options.fetch ? { fetch: options.fetch } : {}) }),
    connectedTo: () => null,
    explain,

    explainSyncFailure(error) {
      if (error instanceof LinkedInGatewayError && error.code === "auth") return "Linked API rejected the saved token. Connect again with a new token.";
      return explain(error);
    },

    webhooks: null,
    connectCallback: null,

    connectSession: {
      oneLinkAtATime: true,

      async status(credentials, link) {
        const client = clientOf(credentials);
        const session = obj((await client.admin("accounts.getConnectionSession", { sessionId: link.ref })).session);
        const state = str(session.status) ?? "";
        if (SESSION_ENDED[state]) return { state: "failed", error: SESSION_ENDED[state] };
        if (state !== "success") return { state: "pending" };
        const rows = preferredAccounts(await client.listAccounts(true)).filter((row) => row.status === "active");
        // A reconnect's own profile is enough, whatever its id and sign-in time do, because it only turns active once it is back.
        const same = link.reconnectAccount?.username ? rows.find((row) => slugOf(row.url) === link.reconnectAccount?.username) : undefined;
        if (same) return { state: "connected", account: same.id };
        // "Login completed, account is being created." Only one link is open at a time, so the newest sign-in since it that no row here holds is this link's.
        const after = link.createdAt.getTime() - CONNECTED_SLACK_MS;
        const signedIn = rows.filter((row) => !link.knownAccounts.includes(row.id) && Date.parse(row.connectedAt ?? "") >= after).sort((x, y) => Date.parse(y.connectedAt ?? "") - Date.parse(x.connectedAt ?? ""))[0];
        return signedIn ? { state: "connected", account: signedIn.id } : { state: "pending" };
      },

      async cancel(credentials, ref) {
        const client = clientOf(credentials);
        await client.admin("accounts.cancelConnectionSession", { sessionId: ref });
        client.forgetListing();
      },
    },
  };
}
