/** Limits and refusals of a lead conversion that the browser shows too. The module loads nothing, so a client component may import it. */

/** Leads one conversion preview reads. The Create deal dialogs send chunks of this size. */
export const MAX_CONVERT_PREVIEW_IDS = 500;

/** What a refused conversion says when `personalCampaignSkip` holds. Deals answers it as 403, the leads routes as 409 `personal_campaign`. */
export const PERSONAL_CAMPAIGN_MESSAGE = "A personal campaign of another member is still reaching this person. Its creator or an admin can create the deal.";
