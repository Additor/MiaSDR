import { ConflictError, ValidationError } from "@/shared/errors";
import { LinkedInGatewayError, type LinkedInGateway, type LinkedInVendor, type LinkedInWebhookAdmin, type VendorCredentials } from "../../../application/linkedin-ports";
import { parseDsn, storedConnection, type DsnPolicy, type DsnScheme } from "./unipile-dsn";
import { UnipileGateway } from "./unipile-gateway";
import { WEBHOOKS, WEBHOOK_SECRET_HEADER } from "./unipile-webhook";

const NAME = "Unipile";
const WEBHOOK_PATH = "/api/webhooks/unipile";
const CONNECT_NOTIFY_PATH = "/api/webhooks/unipile-account";
const CONNECT_RETURN_PATH = "/settings/linkedin";
/** What `notify_url` reports for an account that connected. */
const CONNECTED_STATUSES = new Set(["CREATION_SUCCESS", "RECONNECTED"]);

const withoutSlash = (url: string) => url.replace(/\/$/, "");

/** Turns gateway failures into fixed messages. The upstream error text is never passed on, because the host may not be Unipile. */
function explain(error: unknown): string {
  if (error instanceof LinkedInGatewayError) {
    if (error.code === "auth") return "Unipile rejected the API key. Check the key and the DSN in your Unipile dashboard.";
    if (error.code === "unavailable") return "Could not reach Unipile. Check the DSN and try again.";
    if (error.code === "insufficient_privileges") return "Unipile refused the request because this API key or LinkedIn account lacks access to it.";
    return "Unipile refused the request. Check the DSN and the API key.";
  }
  return "Could not reach Unipile.";
}

export interface UnipileVendorOptions {
  /** Which DSN hosts may receive the API key. Defaults to `*.unipile.com` only. */
  dsnPolicy?: DsnPolicy;
  /** Builds the gateway for a checked DSN. Tests and the fake provider replace it. */
  gatewayFor?: (connection: { dsn: string; scheme: DsnScheme; apiKey: string }) => LinkedInGateway & LinkedInWebhookAdmin;
}

/** Everything specific to Unipile that the connection flows need: its credentials, sentences, webhook setup and callback. */
export function createUnipileVendor(options: UnipileVendorOptions = {}): LinkedInVendor {
  const gatewayFor = options.gatewayFor ?? ((connection) => new UnipileGateway(connection));
  const stored = (credentials: VendorCredentials) => {
    const connection = storedConnection(credentials, options.dsnPolicy);
    if (!connection) throw new ConflictError("The saved Unipile DSN is not allowed. Reconnect with the DSN from your Unipile dashboard.");
    return gatewayFor(connection);
  };
  return {
    key: "unipile",
    name: NAME,
    integrationName: "Unipile (LinkedIn)",
    syncAddsAccounts: true,
    connectLinkMinutes: 15,
    connectSession: null,

    readConnectInput(input) {
      const parsed = parseDsn(input.dsn ?? "", options.dsnPolicy);
      if (!parsed) throw new ValidationError("Enter the DSN as shown in the Unipile dashboard, for example api1.unipile.com:13111. Only Unipile hosts are accepted.");
      const apiKey = (input.apiKey ?? "").trim();
      if (apiKey === "" || apiKey.length > 500) throw new ValidationError("Enter the Unipile API key.");
      return { dsn: parsed.host, apiKey };
    },

    gatewayFor: stored,

    describe: (credentials) => ({ dsn: credentials?.dsn ?? null }),

    explain,

    explainSyncFailure(error) {
      if (error instanceof LinkedInGatewayError && error.code === "auth") return "Unipile rejected the saved key. Connect again with a new key.";
      return explain(error);
    },

    webhooks: {
      requestUrl: (appUrl, organizationId) => `${withoutSlash(appUrl)}${WEBHOOK_PATH}?org=${organizationId}`,
      headerName: WEBHOOK_SECRET_HEADER,
      hooks: WEBHOOKS,
      admin: stored,
    },

    connectCallback: {
      urls({ appUrl, linkId, secret }) {
        const base = withoutSlash(appUrl);
        return {
          success: `${base}${CONNECT_RETURN_PATH}?unipile=success&link=${linkId}`,
          failure: `${base}${CONNECT_RETURN_PATH}?unipile=failure&link=${linkId}`,
          notify: `${base}${CONNECT_NOTIFY_PATH}?link=${linkId}&secret=${encodeURIComponent(secret)}`,
        };
      },

      /** Unipile's body on `notify_url`: { status, account_id, name }. The docs name no signature, so the secret rides in the URL. */
      readNotify(payload) {
        if (!payload || typeof payload !== "object") return null;
        const p = payload as Record<string, unknown>;
        if (typeof p.status !== "string" || typeof p.name !== "string") return null;
        return {
          status: p.status,
          connected: CONNECTED_STATUSES.has(p.status),
          accountId: typeof p.account_id === "string" && p.account_id !== "" ? p.account_id : null,
          name: p.name,
        };
      },
    },
  };
}
