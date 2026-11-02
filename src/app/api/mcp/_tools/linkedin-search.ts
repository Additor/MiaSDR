import { z } from "zod";
import { createAgentSearch } from "@/composition/agent-linkedin-search";
import { cancelAgentLinkedInSearch, DEFAULT_AGENT_SEARCH_RESULTS, listLinkedInSearches, MAX_AGENT_SEARCH_RESULTS } from "@/contexts/outreach/linkedin/application/linkedin-search";
import { getSearchCapacity } from "@/contexts/outreach/linkedin/application/linkedin-search-capacity";
import { linkedinSearchCapacityDeps, linkedinSearchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { CHANGES, defineTool, READ_ONLY } from "./define";
import { fencedField } from "./output";

export const listLinkedInSearchesTool = defineTool({
  name: "list_linkedin_searches",
  title: "List LinkedIn searches",
  description: "The organization's LinkedIn searches, newest first, with their status and results so far. `byAgent` marks one an agent created, the only kind cancel_linkedin_search ends. An owner or admin also sees each account's searches left today.",
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({}),
  output: z.object({
    searches: z.array(z.object({ searchId: z.string(), name: z.string().nullable(), status: z.string(), found: z.number(), imported: z.number(), maxResults: z.number(), byAgent: z.boolean(), lastError: z.string().nullable() })),
    accounts: z.array(z.object({ id: z.string(), name: z.string().nullable(), remaining: z.number() })),
  }),
  async run({ actor, out }) {
    const { searches } = await listLinkedInSearches(linkedinSearchDeps(), actor);
    // Who has which account, and how much of it is left, is an admin's view, as in get_workspace.
    const capacity = isOwnerOrAdmin(actor.role) ? await getSearchCapacity(linkedinSearchCapacityDeps(), actor) : null;
    return {
      summary: `${searches.length} search(es).`,
      structured: {
        searches: searches.map((s) => ({ searchId: s.id, name: fencedField(out, s.name), status: s.status, found: s.found, imported: s.imported, maxResults: s.maxResults, byAgent: s.byAgent, lastError: s.lastError })),
        accounts: (capacity?.accounts ?? []).map((a) => ({ id: a.id, name: fencedField(out, a.name), remaining: a.left })),
      },
    };
  },
});

export const createLinkedInSearchTool = defineTool({
  name: "create_linkedin_search",
  title: "Create LinkedIn search",
  description: [
    "Starts a LinkedIn search from a search `url` (`name`, optional `maxResults`). The people it finds become leads; it enrolls nobody. Use it only when the person asked for this search.",
    "Each search counts its `maxResults` against the organization's daily limit when created (`agent_search_cap`), and it uses LinkedIn accounts this token's person owns or that no member owns (`agent_no_search_account`). It waits for no one: end it with cancel_linkedin_search.",
    "It refuses while sending is paused (`agent_send_paused`).",
  ].join(" "),
  scope: "mcp:spend",
  needs: "search",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: z.strictObject({ name: z.string(), url: z.string(), maxResults: z.number().int().max(MAX_AGENT_SEARCH_RESULTS).optional() }),
  output: z.object({ searchId: z.string(), maxResults: z.number() }),
  buckets: () => ["write", "spend"],
  async run({ actor }, input) {
    const maxResults = input.maxResults ?? DEFAULT_AGENT_SEARCH_RESULTS;
    const { id } = await createAgentSearch(actor, { name: input.name, url: input.url, maxResults });
    return { summary: `Started search ${id} for up to ${maxResults} results.`, structured: { searchId: id, maxResults } };
  },
});

export const cancelLinkedInSearchTool = defineTool({
  name: "cancel_linkedin_search",
  title: "Cancel LinkedIn search",
  description: "Ends a search an agent created (`searchId`). The people it found stay in Leads. A person's search refuses (`agent_search_not_agents`).",
  scope: "mcp:write",
  annotations: CHANGES,
  input: z.object({ searchId: z.string() }),
  output: z.object({ searchId: z.string(), status: z.string() }),
  async run({ actor }, input) {
    const { status } = await cancelAgentLinkedInSearch(linkedinSearchDeps(), actor, input.searchId);
    return { summary: "The search is cancelled. The people it found stay in Leads.", structured: { searchId: input.searchId, status } };
  },
});
