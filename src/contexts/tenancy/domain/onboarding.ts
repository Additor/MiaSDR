/** Counts read from the organization's tables. The checklist status derives from these and nothing else. */
export interface OnboardingFacts {
  /** A time zone was saved for the organization (setup stores one unless it is UTC; Email rules stores it too). */
  timeZoneSaved: boolean;
  connectedMailboxes: number;
  /** Mailboxes in any state, so a failed connection can be told apart from none. */
  totalMailboxes: number;
  connectedLinkedInAccounts: number;
  leads: number;
  campaigns: number;
  activeCampaigns: number;
  /** Drafts in `awaiting_review` that a person can see in the Inbox. */
  draftsAwaiting: number;
  /** Drafts a person approved that went out (`sent`). */
  messagesApproved: number;
  /** Where AI setup stands. The integrations context decides it; the app wires it in. */
  aiSetup: AiSetup;
}

/**
 * `needs_model`: a key is saved for a provider with no default model, and nobody picked one, so AI is off.
 * `on` carries what runs, such as "Anthropic, claude-sonnet-5-5", or "Demo mode" when no provider is called.
 */
export type AiSetup = { state: "none" } | { state: "needs_model"; provider: string } | { state: "needs_key"; provider: string } | { state: "on"; running: string };

function aiStepDetail(setup: AiSetup): string | null {
  if (setup.state === "on") return `AI runs on ${setup.running}`;
  if (setup.state === "needs_model") return `${setup.provider} key saved. AI is off until a model is picked.`;
  if (setup.state === "needs_key") return `The saved ${setup.provider} key cannot be read. AI is off until it is saved again.`;
  return null;
}

export type StepId = "profile" | "mailbox" | "linkedin" | "leads" | "campaign" | "approve" | "ai";
/** `attention`: the person started but something needs a fix (a mailbox that failed to connect). */
export type StepStatus = "done" | "todo" | "attention";

export interface OnboardingStep {
  id: StepId;
  title: string;
  description: string;
  optional: boolean;
  status: StepStatus;
  /** Real numbers behind the status, shown next to it. Null when there is nothing to count. */
  detail: string | null;
  href: string;
  action: string;
}

export interface OnboardingChecklist {
  steps: OnboardingStep[];
  /** Required steps that are done, out of `requiredTotal`. */
  requiredDone: number;
  requiredTotal: number;
  complete: boolean;
  /** First unfinished required step, falling back to the first unfinished optional one. */
  nextStepId: StepId | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function deriveChecklist(facts: OnboardingFacts): OnboardingChecklist {
  const mailboxStatus: StepStatus = facts.connectedMailboxes > 0 ? "done" : facts.totalMailboxes > 0 ? "attention" : "todo";
  // Required steps first, then the optional ones, so a list rendered in this order never puts an optional step in the way.
  const steps: OnboardingStep[] = [
    {
      id: "profile",
      title: "Set the time zone",
      description: "Working hours and daily limits follow this time zone.",
      optional: false,
      status: facts.timeZoneSaved ? "done" : "todo",
      detail: facts.timeZoneSaved ? "Time zone saved" : null,
      href: "/settings/organization",
      action: "Set time zone",
    },
    {
      id: "mailbox",
      title: "Connect a mailbox",
      description: "Campaigns send from a connected Gmail address.",
      optional: false,
      status: mailboxStatus,
      detail:
        mailboxStatus === "done"
          ? `${plural(facts.connectedMailboxes, "mailbox", "mailboxes")} connected`
          : mailboxStatus === "attention"
            ? `${plural(facts.totalMailboxes, "mailbox", "mailboxes")} added, none connected`
            : null,
      href: "/settings/mailboxes",
      action: mailboxStatus === "attention" ? "Fix mailbox" : "Connect mailbox",
    },
    {
      id: "leads",
      title: "Import leads",
      description: "Upload a CSV or XLSX file, or search LinkedIn.",
      optional: false,
      status: facts.leads > 0 ? "done" : "todo",
      detail: facts.leads > 0 ? `${plural(facts.leads, "lead")} imported` : null,
      href: "/leads/import",
      action: "Import leads",
    },
    {
      id: "campaign",
      title: "Create your first campaign",
      description: "Write the sequence, add leads and start it when the preview looks right.",
      optional: false,
      status: facts.campaigns > 0 ? "done" : "todo",
      detail:
        facts.campaigns > 0
          ? `${plural(facts.campaigns, "campaign")}, ${facts.activeCampaigns} running`
          : null,
      href: "/campaigns",
      action: "Create campaign",
    },
    {
      id: "approve",
      title: "Approve your first message",
      description: "Nothing is sent until a person approves it. Review a draft and send it.",
      optional: false,
      status: facts.messagesApproved > 0 ? "done" : "todo",
      detail:
        facts.messagesApproved > 0
          ? `${plural(facts.messagesApproved, "message")} approved and sent`
          : facts.draftsAwaiting > 0
            ? `${plural(facts.draftsAwaiting, "draft")} waiting for your approval`
            : facts.campaigns > 0
              ? "No drafts waiting yet"
              : "Nothing to approve yet: start a campaign first",
      href: facts.draftsAwaiting > 0 ? "/inbox" : "/campaigns",
      action: facts.draftsAwaiting > 0 ? "Review drafts" : "Open campaigns",
    },
    {
      id: "linkedin",
      title: "Connect LinkedIn",
      description: "Optional. Adds LinkedIn invitations and messages through Unipile.",
      optional: true,
      status: facts.connectedLinkedInAccounts > 0 ? "done" : "todo",
      detail: facts.connectedLinkedInAccounts > 0 ? `${plural(facts.connectedLinkedInAccounts, "account")} connected` : null,
      href: "/settings/linkedin",
      action: "Connect LinkedIn",
    },
    {
      id: "ai",
      title: "Add an AI key",
      description: "Optional. Lets MiaSDR classify replies and draft answers for your approval.",
      optional: true,
      status: facts.aiSetup.state === "on" ? "done" : facts.aiSetup.state === "none" ? "todo" : "attention",
      detail: aiStepDetail(facts.aiSetup),
      href: "/settings/integrations",
      action: facts.aiSetup.state === "needs_model" ? "Pick a model" : facts.aiSetup.state === "needs_key" ? "Replace key" : "Add key",
    },
  ];

  const required = steps.filter((s) => !s.optional);
  const requiredDone = required.filter((s) => s.status === "done").length;
  const next = steps.find((s) => !s.optional && s.status !== "done") ?? steps.find((s) => s.status !== "done");
  return {
    steps,
    requiredDone,
    requiredTotal: required.length,
    complete: requiredDone === required.length,
    nextStepId: next?.id ?? null,
  };
}
