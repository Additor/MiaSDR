import { z } from "zod";
import { dealsDeps } from "@/composition/deals";
import { getReplyTypeCatalog } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { listDealStages } from "@/contexts/deals/application/deal-stages";
import { listMailboxes } from "@/contexts/outreach/email/application/mailbox-management";
import { mailboxDeps } from "@/contexts/outreach/infrastructure/composition";
import { listLinkedInAccountStatus } from "@/contexts/outreach/linkedin/application/linkedin-management";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { listMembers } from "@/contexts/tenancy/application/member-management";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { memberDeps } from "@/contexts/tenancy/infrastructure/member-composition";
import { defineTool, READ_ONLY } from "./define";

const output = z.object({
  members: z.array(z.object({ userId: z.string(), name: z.string(), email: z.string(), role: z.string() })),
  replyTypes: z.array(z.object({ id: z.string(), key: z.string(), name: z.string(), group: z.string() })),
  dealStages: z.array(z.object({ id: z.string().nullable(), name: z.string(), kind: z.string() })),
  mailboxes: z.array(z.object({ id: z.string(), emailAddress: z.string(), displayName: z.string().nullable(), status: z.string(), dailySendLimit: z.number(), sentToday: z.number() })),
  /** Owners and admins only, as on the LinkedIn settings page. */
  linkedinAccounts: z.union([z.array(z.object({ id: z.string(), name: z.string().nullable(), username: z.string().nullable(), status: z.string(), isPremium: z.boolean() })), z.literal("omitted")]),
});

export const getWorkspace = defineTool({
  name: "get_workspace",
  title: "Get workspace",
  description:
    "The organization's members, active reply types, deal stages, mailboxes and, for an owner or admin, LinkedIn accounts, with the ids other tools take. Call it first to learn who `assignedTo` names and which reply type or stage an id means.",
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({}),
  output,
  async run({ actor }) {
    const [members, catalog, stages, mailboxes, linkedin] = await Promise.all([
      listMembers(memberDeps(), actor),
      getReplyTypeCatalog(replyHandlingDeps(), actor),
      listDealStages(dealsDeps(), actor),
      listMailboxes(mailboxDeps(), actor),
      isOwnerOrAdmin(actor.role) ? listLinkedInAccountStatus(linkedinManagementDeps(), actor) : null,
    ]);
    const structured = {
      members: members.map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role })),
      replyTypes: catalog.replyTypes.filter((t) => t.active).map((t) => ({ id: t.id, key: t.key, name: t.name, group: t.groupKey })),
      // A stage with a null id is a default the organization has not saved yet; deals cannot point at it.
      dealStages: stages.stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      mailboxes: mailboxes.map((m) => ({ id: m.id, emailAddress: m.emailAddress, displayName: m.displayName, status: m.status, dailySendLimit: m.dailySendLimit, sentToday: m.sentToday })),
      linkedinAccounts: linkedin ? linkedin.map((a) => ({ id: a.id, name: a.name, username: a.username, status: a.status, isPremium: a.isPremium })) : ("omitted" as const),
    };
    const summary = [
      `Members (${structured.members.length}): ${structured.members.map((m) => `${m.name} (${m.role})`).join(", ")}.`,
      `${structured.replyTypes.length} reply types, ${structured.dealStages.length} deal stages, ${structured.mailboxes.length} mailboxes${linkedin ? `, ${linkedin.length} LinkedIn accounts` : ""}.`,
    ].join("\n");
    return { summary, structured };
  },
});
