import { ValidationError } from "@/shared/errors";
import { LinkedInGatewayError, type LinkedInVendor, type VendorCredentials } from "../../../application/linkedin-ports";
import { GtmGateway } from "./gtm-gateway";

const NAME = "gtm-api";

function explain(error: unknown): string {
  if (error instanceof LinkedInGatewayError) {
    if (error.code === "auth") return "gtm-api rejected the API key. Check the key in gtm-api, or that the account is still signed in there.";
    if (error.code === "unavailable") return "Could not reach gtm-api. Try again.";
    if (error.code === "rate_limited") return "gtm-api refused for now: its plan or a limit. Check your gtm-api workspace, or try again later.";
    return "gtm-api refused the request. Check your gtm-api workspace.";
  }
  return "Could not reach gtm-api.";
}

/** Everything specific to gtm-api that the connection flows need. Accounts connect in its own app, and replies are read from its store. */
export function createGtmVendor(): LinkedInVendor {
  return {
    key: "gtmapi",
    name: NAME,
    integrationName: "gtm-api (LinkedIn)",
    // The key belongs to one team, so its accounts are this organization's. Every one of them is read.
    syncAddsAccounts: true,
    connectLinkMinutes: null,
    inboundNote: "MiaSDR reads replies and acceptances from gtm-api about every 10 minutes. How fresh they are depends on how often gtm-api syncs each account, which you set in gtm-api.",

    readConnectInput(input) {
      const apiKey = (input.apiKey ?? "").trim();
      if (apiKey === "" || apiKey.length > 500) throw new ValidationError("Enter the gtm-api API key.");
      return { apiKey };
    },

    gatewayFor: (credentials: VendorCredentials) => new GtmGateway({ apiKey: credentials.apiKey ?? "" }),
    connectedTo: () => null,
    explain,

    explainSyncFailure(error) {
      if (error instanceof LinkedInGatewayError && error.code === "auth") return "gtm-api rejected the saved key. Connect again with a new key.";
      return explain(error);
    },

    webhooks: null,
    connectCallback: null,
    connectSession: null,
  };
}
