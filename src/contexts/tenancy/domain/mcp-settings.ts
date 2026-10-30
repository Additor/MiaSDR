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
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  memberWriteTokens: true,
  agentSendMode: "off",
  agentSendEpoch: 0,
  agentReplyCaps: { org: 100, user: 50, mailbox: 30 },
  agentEnrollCap: 200,
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

/** The stored values with each missing or malformed key replaced by its default. */
export function readMcpSettings(raw: Record<string, unknown> | null | undefined): McpSettings {
  const values = raw ?? {};
  return {
    enabled: typeof values.enabled === "boolean" ? values.enabled : DEFAULT_MCP_SETTINGS.enabled,
    memberWriteTokens: typeof values.memberWriteTokens === "boolean" ? values.memberWriteTokens : DEFAULT_MCP_SETTINGS.memberWriteTokens,
    agentSendMode: isMode(values.agentSendMode) ? values.agentSendMode : DEFAULT_MCP_SETTINGS.agentSendMode,
    agentSendEpoch: isWhole(values.agentSendEpoch, Number.MAX_SAFE_INTEGER) ? values.agentSendEpoch : DEFAULT_MCP_SETTINGS.agentSendEpoch,
    agentReplyCaps: readCaps(values.agentReplyCaps),
    agentEnrollCap: isWhole(values.agentEnrollCap, MAX_AGENT_ENROLL_CAP) ? values.agentEnrollCap : DEFAULT_MCP_SETTINGS.agentEnrollCap,
  };
}

/** The keys a person may save. The epoch is not one: only the mode change writes it, inside the database. */
export type McpSettingsPatch = Partial<Omit<McpSettings, "agentSendEpoch">>;

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
      default:
        return `${key} is not an MCP setting.`;
    }
  }
  return null;
}
