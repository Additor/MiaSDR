import { ValidationError } from "@/shared/errors";
import { LinkedInGatewayError, type LinkedInVendor, type VendorCredentials } from "../../../application/linkedin-ports";
import { EdgesSignInLostError } from "./edges-errors";
import { EdgesGateway } from "./edges-gateway";

const NAME = "Edges";

function explain(error: unknown): string {
  if (error instanceof LinkedInGatewayError) {
    if (error instanceof EdgesSignInLostError) return "Edges no longer holds this LinkedIn sign-in. Sign in again, or connect the account as a new one.";
    if (error.code === "auth") return "Edges rejected the API key. Create a new key in Edges, Settings, Developers.";
    if (error.code === "unavailable") return "Could not reach Edges. Try again.";
    if (error.code === "rate_limited") return "Edges refused for now: its plan, credits or a limit. Check your Edges workspace, or try again later.";
    return "Edges refused the request. Check your Edges workspace.";
  }
  return "Could not reach Edges.";
}

/** Everything specific to Edges that the connection flows need. It has no message webhook and no connect callback: replies are read, and a link is asked about. */
export function createEdgesVendor(): LinkedInVendor {
  const stored = (credentials: VendorCredentials) => new EdgesGateway({ apiKey: credentials.apiKey ?? "" });
  return {
    key: "edges",
    name: NAME,
    integrationName: "Edges (LinkedIn)",
    // A workspace lists every identity in it, including ones nobody connected through this app.
    syncAddsAccounts: false,
    // Edges' login links last 48 hours.
    connectLinkMinutes: 48 * 60,

    readConnectInput(input) {
      const apiKey = (input.apiKey ?? "").trim();
      if (apiKey === "" || apiKey.length > 500) throw new ValidationError("Enter the Edges API key.");
      return { apiKey };
    },

    gatewayFor: stored,
    describe: () => ({ dsn: null }),
    explain,

    explainSyncFailure(error) {
      if (error instanceof LinkedInGatewayError && error.code === "auth" && !(error instanceof EdgesSignInLostError)) return "Edges rejected the saved key. Connect again with a new key.";
      return explain(error);
    },

    webhooks: null,
    connectCallback: null,

    connectSession: {
      status: (credentials, account) => stored(credentials).integrationStatus(account),
      cancel: (credentials, account) => stored(credentials).removeUnusedIdentity(account),
    },
  };
}
