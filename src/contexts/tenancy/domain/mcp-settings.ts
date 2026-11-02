/**
 * The organization's MCP settings, stored in its `mcp` channel settings row. Each key falls back to its default on its
 * own, so one bad value never resets the others.
 */
export const MCP_SETTINGS_CHANNEL = "mcp";

export const AGENT_SEND_MODES = ["off", "replies", "replies_and_campaigns"] as const;
export type AgentSendMode = (typeof AGENT_SEND_MODES)[number];

/** Upper bounds for the agent caps. The enroll bound matches one enroll batch (`MAX_ENROLL_BATCH`). */
export const MAX_AGENT_REPLY_CAP = 1000;
export const MAX_AGENT_ENROLL_CAP = 5000;
export const MAX_AGENT_SPEND_CENTS = 100_000;
export const MAX_AGENT_SEARCH_LEADS = 5000;
export const MAX_AGENT_IRREVERSIBLE = 200;

export interface AgentReplyCaps {
  /** Agent replies per UTC day across the organization. */
  org: number;
  /** Agent replies per UTC day sent with one person's tokens. */
  user: number;
  /** Agent email replies per UTC day from one mailbox. LinkedIn keeps its account limits. */
  mailbox: number;
}

export interface McpSettings {
  /** The organization's MCP endpoint answers. An owner or admin turns it on. */
  enabled: boolean;
  /** Members may create tokens that write. Owners and admins always may. */
  memberWriteTokens: boolean;
  agentSendMode: AgentSendMode;
  /** Goes up by one each time the mode drops to `off`. A send token made under an older epoch cannot send. */
  agentSendEpoch: number;
  agentReplyCaps: AgentReplyCaps;
  /** People agents may enroll per UTC day, both channels and every campaign status together. */
  agentEnrollCap: number;
  /** Cents agents may reserve for enrichment per UTC day, at the prices an admin entered. 0 turns it off. */
  agentSpendCentsPerDay: number;
  /** Results agents may ask LinkedIn searches for per UTC day. 0 turns it off. */
  agentSearchLeadsPerDay: number;
  /** Goes up by one each time both spending limits drop to 0. A spend token made under an older epoch cannot spend. */
  agentSpendEpoch: number;
  /** Actions agents may take per UTC day that a person cannot undo. 0 turns them off. */
  agentIrreversiblePerDay: number;
  /** Goes up by one each time that limit drops to 0. An irreversible token made under an older epoch cannot act. */
  agentIrreversibleEpoch: number;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  memberWriteTokens: true,
  agentSendMode: "off",
  agentSendEpoch: 0,
  agentReplyCaps: { org: 100, user: 50, mailbox: 30 },
  agentEnrollCap: 200,
  agentSpendCentsPerDay: 0,
  agentSearchLeadsPerDay: 0,
  agentSpendEpoch: 0,
  agentIrreversiblePerDay: 0,
  agentIrreversibleEpoch: 0,
};

const isWhole = (value: unknown, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
const isMode = (value: unknown): value is AgentSendMode => typeof value === "string" && (AGENT_SEND_MODES as readonly string[]).includes(value);

function readCaps(raw: unknown): AgentReplyCaps {
  const caps = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fallback = DEFAULT_MCP_SETTINGS.agentReplyCaps;
  return {
    org: isWhole(caps.org, MAX_AGENT_REPLY_CAP) ? caps.org : fallback.org,
    user: isWhole(caps.user, MAX_AGENT_REPLY_CAP) ? caps.user : fallback.user,
    mailbox: isWhole(caps.mailbox, MAX_AGENT_REPLY_CAP) ? caps.mailbox : fallback.mailbox,
  };
}

/**
 * The stored values with each missing or malformed key replaced by its default. A malformed epoch also turns off what
 * it guards: falling back to 0 would let a token from before an earlier drop match again.
 */
export function readMcpSettings(raw: Record<string, unknown> | null | undefined): McpSettings {
  const values = raw ?? {};
  const epochValid = (epoch: unknown) => epoch === undefined || isWhole(epoch, Number.MAX_SAFE_INTEGER);
  const epoch = (value: unknown) => (isWhole(value, Number.MAX_SAFE_INTEGER) ? value : 0);
  const limit = (value: unknown, max: number, valid: boolean) => (valid && isWhole(value, max) ? value : 0);
  const spendValid = epochValid(values.agentSpendEpoch);
  const irreversibleValid = epochValid(values.agentIrreversibleEpoch);
  return {
    enabled: typeof values.enabled === "boolean" ? values.enabled : DEFAULT_MCP_SETTINGS.enabled,
    memberWriteTokens: typeof values.memberWriteTokens === "boolean" ? values.memberWriteTokens : DEFAULT_MCP_SETTINGS.memberWriteTokens,
    agentSendMode: epochValid(values.agentSendEpoch) && isMode(values.agentSendMode) ? values.agentSendMode : "off",
    agentSendEpoch: isWhole(values.agentSendEpoch, Number.MAX_SAFE_INTEGER) ? values.agentSendEpoch : DEFAULT_MCP_SETTINGS.agentSendEpoch,
    agentReplyCaps: readCaps(values.agentReplyCaps),
    agentEnrollCap: isWhole(values.agentEnrollCap, MAX_AGENT_ENROLL_CAP) ? values.agentEnrollCap : DEFAULT_MCP_SETTINGS.agentEnrollCap,
    agentSpendCentsPerDay: limit(values.agentSpendCentsPerDay, MAX_AGENT_SPEND_CENTS, spendValid),
    agentSearchLeadsPerDay: limit(values.agentSearchLeadsPerDay, MAX_AGENT_SEARCH_LEADS, spendValid),
    agentSpendEpoch: epoch(values.agentSpendEpoch),
    agentIrreversiblePerDay: limit(values.agentIrreversiblePerDay, MAX_AGENT_IRREVERSIBLE, irreversibleValid),
    agentIrreversibleEpoch: epoch(values.agentIrreversibleEpoch),
  };
}

/** The keys a person may save. The epochs are not: only the change that retires tokens writes one, inside the database. */
export type McpSettingsPatch = Partial<Omit<McpSettings, "agentSendEpoch" | "agentSpendEpoch" | "agentIrreversibleEpoch">>;

/** The first problem with a patch, as a sentence, or null when every key it holds is valid. */
export function mcpSettingsProblem(patch: Record<string, unknown>): string | null {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    switch (key) {
      case "enabled":
      case "memberWriteTokens":
        if (typeof value !== "boolean") return `${key} must be true or false.`;
        break;
      case "agentSendMode":
        if (!isMode(value)) return `Agent sending must be one of ${AGENT_SEND_MODES.join(", ")}.`;
        break;
      case "agentReplyCaps": {
        const caps = value as Record<string, unknown> | null;
        if (!caps || typeof caps !== "object") return "Agent reply limits are missing.";
        for (const name of ["org", "user", "mailbox"]) {
          if (!isWhole(caps[name], MAX_AGENT_REPLY_CAP)) return `Each agent reply limit must be a whole number from 0 to ${MAX_AGENT_REPLY_CAP}.`;
        }
        break;
      }
      case "agentEnrollCap":
        if (!isWhole(value, MAX_AGENT_ENROLL_CAP)) return `The agent enroll limit must be a whole number from 0 to ${MAX_AGENT_ENROLL_CAP}.`;
        break;
      case "agentSpendCentsPerDay":
        if (!isWhole(value, MAX_AGENT_SPEND_CENTS)) return `The agent spending limit must be a whole number of cents from 0 to ${MAX_AGENT_SPEND_CENTS}.`;
        break;
      case "agentSearchLeadsPerDay":
        if (!isWhole(value, MAX_AGENT_SEARCH_LEADS)) return `The agent search limit must be a whole number from 0 to ${MAX_AGENT_SEARCH_LEADS}.`;
        break;
      case "agentIrreversiblePerDay":
        if (!isWhole(value, MAX_AGENT_IRREVERSIBLE)) return `The limit on actions agents cannot undo must be a whole number from 0 to ${MAX_AGENT_IRREVERSIBLE}.`;
        break;
      default:
        return `${key} is not an MCP setting.`;
    }
  }
  return null;
}
