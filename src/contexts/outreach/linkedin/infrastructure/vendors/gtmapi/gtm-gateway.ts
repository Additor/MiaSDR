import { LinkedInGatewayError, type GatewayAccount, type GatewayProfile, type LinkedInGateway, type LinkedInRecipient, type NetworkDistance, type SearchItem, type SearchPage } from "../../../application/linkedin-ports";
import { linkedinSlug, profileUrlFor } from "../../../domain/linkedin";
import { isBareProviderId, normalizePublicSlug } from "../../../domain/linkedin-identity";
import { gatewayErrorFrom, type GtmErrorContext } from "./gtm-errors";
import { GtmClient, GtmRequestError, type GtmClientOptions } from "./gtm-http";
import { accountReadiness, itemsOf, memberIdOf, obj, str, type Row } from "./gtm-rows";

const MAX_NOTE = 300;
const MAX_MESSAGE = 8000;
const PAGE_SIZE = 200;
const CLASSIC_SEARCH = "https://www.linkedin.com/search/results/people/";
const SALES_NAV_SEARCH = "https://www.linkedin.com/sales/search/people";

const INVITATION: GtmErrorContext = { write: true, limits: "invitations" };
const MESSAGE: GtmErrorContext = { write: true };
const LOOKUP: GtmErrorContext = { limits: "invitations" };

const DISTANCE: Record<string, NetworkDistance> = { "1st": "first", "2nd": "second", "3rd": "third", "3rd+": "out_of_network", "4_plus": "out_of_network" };
const distanceOf = (value: unknown): NetworkDistance => DISTANCE[str(value) ?? ""] ?? "unknown";

/** A public slug, never a member id: a slug is what tells two accounts apart on a later sync. */
function slugOf(nickname: unknown): string | null {
  const slug = str(nickname);
  return slug && !isBareProviderId(slug) ? normalizePublicSlug(slug) : null;
}

const splitName = (full: string | null) => {
  const [first, ...rest] = (full ?? "").trim().split(/\s+/);
  return { firstName: first || null, lastName: rest.join(" ") || null };
};

const isPlaceRequired = (error: unknown) => error instanceof GtmRequestError && error.reason === "place_required";

/**
 * LinkedIn through gtm-api. An account is a `ln_ac_` sid, and an account connects only in gtm-api's own app, so this has no
 * connect link. Sends go by `ln_id` alone: a key is tied to the place it was sent to, and a chat learned between two attempts
 * would be another place, so another send.
 */
export class GtmGateway implements LinkedInGateway {
  readonly client: GtmClient;
  private readonly listed = new Map<string, Row>();

  constructor(options: GtmClientOptions) {
    this.client = new GtmClient(options);
  }

  private async attempt<T>(call: () => Promise<T>, context: GtmErrorContext = {}): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw error instanceof LinkedInGatewayError ? error : gatewayErrorFrom(error, context);
    }
  }

  verify(): Promise<void> {
    return this.attempt(async () => {
      await this.client.read("/api/linkedin-accounts/search", { page_size: 1 });
    });
  }

  /** Every account of the key's team. One still on its first sync, or with no member id yet, is left for a later sync. */
  listAccounts(): Promise<GatewayAccount[]> {
    return this.attempt(async () => {
      const accounts: GatewayAccount[] = [];
      let cursor: string | null = null;
      do {
        const answer: Record<string, unknown> = await this.client.read("/api/linkedin-accounts/search", { include: ["antidetect_browser"], page_size: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        for (const { item, included } of itemsOf(answer)) {
          const ref = str(item.sid);
          const member = memberIdOf(item.ln_id);
          const readiness = accountReadiness(item, included);
          if (!ref || !member || readiness === "not_yet") continue;
          this.listed.set(ref, item);
          accounts.push({ ref, linkedinId: member, name: str(item.full_name), username: slugOf(item.nickname), status: readiness });
        }
        cursor = str(obj(answer.pagination).next_cursor);
      } while (cursor);
      return accounts;
    });
  }

  /** From the listing, so the hourly sync spends none of the account's enrichment budget. */
  getOwnProfile(account: string): Promise<GatewayProfile> {
    return this.attempt(async () => {
      const row = this.listed.get(account) ?? itemsOf(await this.client.read("/api/linkedin-accounts/search", { filter: { sid: { eq: account } }, page_size: 1 }))[0]?.item;
      const member = memberIdOf(row?.ln_id);
      if (!row || !member) throw new LinkedInGatewayError("gtm-api did not name this account's LinkedIn member id.", "definite", "rejected");
      return { member, publicSlug: slugOf(row.nickname), ...splitName(str(row.full_name)), headline: null, location: null, pictureUrl: str(row.avatar_url), networkDistance: "unknown", isPremium: row.has_premium === true };
    });
  }

  /** The cheapest person read. It spends the account's enrichment budget, so a refusal holds invitations and not the account. */
  getProfile(input: { account: string; identifier: string; linkedinApi?: "sales_navigator" | "recruiter" }): Promise<GatewayProfile> {
    return this.attempt(async () => {
      if (input.linkedinApi === "recruiter") throw new LinkedInGatewayError("gtm-api Recruiter members are not supported here.", "definite", "insufficient_privileges");
      // A lead with no stored slug arrives here as its profile URL.
      const target = isBareProviderId(input.identifier) || input.linkedinApi ? { profile_id: input.identifier } : { public_identifier: linkedinSlug(input.identifier) ?? input.identifier };
      const answer = await this.client.read("/api/linkedin-enrichment/person-lite-profile", { ...target, linkedin_account_sid: input.account });
      const profile = obj(obj(answer.result).profile);
      const member = memberIdOf(profile.ln_id);
      if (!member) throw new LinkedInGatewayError("gtm-api gave no LinkedIn member id for this person.", "definite", "not_found");
      return { member, publicSlug: slugOf(profile.nickname), ...splitName(str(profile.full_name)), headline: null, location: null, pictureUrl: null, networkDistance: distanceOf(profile.network_distance), isPremium: false };
    }, LOOKUP);
  }

  sendInvitation(input: { account: string; member: string; note: string | null; sendKey: string }): Promise<{ invitationId: string | null }> {
    return this.attempt(async () => {
      if (input.note && input.note.length > MAX_NOTE) throw new LinkedInGatewayError(`The invitation note is ${input.note.length} characters; gtm-api allows ${MAX_NOTE}.`, "definite", "invalid_recipient");
      const answer = await this.client.write("/api/linkedin-connection-requests/send", {
        linkedin_account_sid: input.account,
        profile_id: input.member,
        client_reference: input.sendKey,
        ...(input.note?.trim() ? { note: input.note } : {}),
      });
      if (answer.success !== true) throw new LinkedInGatewayError("gtm-api answered the invitation without saying it went out.", "unknown", "unavailable");
      return { invitationId: str(obj(answer.item).invitation_id) };
    }, INVITATION);
  }

  /** Asks by key alone. A place in another form than the send's is refused, so it goes along only when gtm-api asks for one. */
  private async checkSent(path: string, key: { linkedin_account_sid: string; client_reference: string }, place: Record<string, string> | null): Promise<{ outcome: string; item: Row }> {
    let answer: Record<string, unknown>;
    try {
      answer = await this.client.write(path, key);
    } catch (error) {
      if (!isPlaceRequired(error) || !place) throw error;
      answer = await this.client.write(path, { ...key, ...place });
    }
    return { outcome: str(obj(answer.result).outcome) ?? "", item: obj(answer.item) };
  }

  invitationStatus(input: { account: string; member: string; since: Date; sendKey: string }): Promise<"pending" | "accepted" | "none"> {
    return this.attempt(async () => {
      const { outcome, item } = await this.checkSent("/api/linkedin-connection-requests/check-sent", { linkedin_account_sid: input.account, client_reference: input.sendKey }, { profile_id: input.member });
      if (outcome === "not_sent") return "none";
      if (outcome !== "sent") throw new LinkedInGatewayError(`gtm-api cannot tell yet (${outcome || "no outcome"}).`, "unknown", "unavailable");
      return item.removal_kind === "accepted" ? "accepted" : "pending";
    });
  }

  sendMessage(input: { account: string; to: LinkedInRecipient; text: string; sendKey: string; unlessRepliedAfter: Date | null }): Promise<{ chat: string | null; messageId: string | null }> {
    return this.attempt(async () => {
      if (input.text.length > MAX_MESSAGE) throw new LinkedInGatewayError(`The message is ${input.text.length} characters; gtm-api sends at most ${MAX_MESSAGE}.`, "definite", "invalid_recipient");
      const person = input.to.member ? { ln_id: input.to.member } : input.to.slug ? { public_identifier: input.to.slug } : null;
      if (!person) throw new LinkedInGatewayError("No LinkedIn member or profile is known for this conversation.", "definite", "invalid_recipient");
      const answer = await this.client.write("/api/linkedin-messages/send", {
        linkedin_account_sid: input.account,
        ...person,
        text: input.text,
        client_reference: input.sendKey,
        ...(input.unlessRepliedAfter ? { stop_if_replied_after: input.unlessRepliedAfter.toISOString() } : {}),
      });
      if (answer.success !== true) throw new LinkedInGatewayError("gtm-api answered the message without saying it went out.", "unknown", "unavailable");
      return { chat: null, messageId: str(obj(answer.item).sid) };
    }, MESSAGE);
  }

  /** Null leads to a resend under the same key, which gtm-api answers instead of sending if it went out after all. */
  findSentMessage(input: { account: string; to: LinkedInRecipient; text: string; since: Date; sendKey: string }): Promise<{ messageId: string | null } | null> {
    return this.attempt(async () => {
      const place = input.to.member ? { profile_urn: input.to.member } : null;
      const { outcome, item } = await this.checkSent("/api/linkedin-messages/check-sent", { linkedin_account_sid: input.account, client_reference: input.sendKey }, place);
      if (outcome === "not_sent") return null;
      if (outcome !== "sent") throw new LinkedInGatewayError(`gtm-api cannot tell yet (${outcome || "no outcome"}).`, "unknown", "unavailable");
      return { messageId: str(item.sid) };
    });
  }

  searchPeople(input: { account: string; searchUrl: string; cursor: string | null }): Promise<SearchPage> {
    return this.attempt(async () => {
      const url = input.searchUrl.trim();
      const path = url.startsWith(CLASSIC_SEARCH) ? "search-people" : url.startsWith(SALES_NAV_SEARCH) ? "search-sales-nav-people" : null;
      if (!path) throw new LinkedInGatewayError("gtm-api searches a LinkedIn or Sales Navigator people search URL.", "definite", "invalid_recipient");
      const page = input.cursor ? Number(input.cursor) : 1;
      const answer = await this.client.read(`/api/linkedin-scraping/${path}`, { linkedin_account_sid: input.account, url, page });
      const result = obj(answer.result);
      // LinkedIn's monthly search limit may have cut this page, so the search must not read as finished.
      if (result.commercial_use_limit_hit === true) throw new LinkedInGatewayError("LinkedIn's monthly search limit stopped this search. Try Sales Navigator, or again next month.", "definite", "rejected");
      if (!Array.isArray(result.rows)) throw new LinkedInGatewayError("gtm-api answered the search without rows.", "unknown", "unavailable");
      const paging = obj(result.paging);
      return {
        items: (result.rows as unknown[]).map((row) => searchItemFrom(obj(row))).filter((item) => item !== null),
        nextCursor: paging.has_more === true ? String(page + 1) : null,
        totalEstimate: typeof paging.total === "number" ? paging.total : null,
      };
    }, LOOKUP);
  }
}

function searchItemFrom(row: Row): SearchItem | null {
  const slug = slugOf(row.nickname);
  const identifier = slug ?? memberIdOf(row.ln_id) ?? str(row.sn_id);
  if (!identifier) return null;
  return {
    identifier,
    profileUrl: slug ? profileUrlFor(slug) : null,
    name: str(row.full_name),
    headline: str(row.headline),
    location: str(row.location),
    networkDistance: str(row.connection_degree),
    raw: row,
  };
}
