import { mailtoHref, profileHref } from "./lead-contact-links";
import { canonicalProfileUrl } from "./linkedin-url";

/*
 * The contact points of a person (address and profile URL), which the leads context owns. The outreach context adds
 * the lead status and the reachability in `outreach/application/read-lead-activity.ts`.
 */

export interface LeadContactPoints {
  /** The address and its `mailto:` link, or null when the lead has no usable address. */
  email: { address: string; href: string } | null;
  /** The profile link for a new tab, or null when the lead has no LinkedIn profile or the stored value is not an http(s) URL. */
  linkedin: { href: string } | null;
}

/**
 * The stored URL wins when it is a safe http(s) link, the slug fills in when only the slug exists or the stored value
 * cannot be linked (a bare provider id, say). An address that cannot make a safe `mailto:` counts as missing.
 */
export function leadContactPoints(lead: { email: string | null; linkedinSlug: string | null; linkedinUrl: string | null }): LeadContactPoints {
  const emailHref = mailtoHref(lead.email);
  const linkedinHref = profileHref(lead.linkedinUrl) ?? (lead.linkedinSlug ? profileHref(canonicalProfileUrl(lead.linkedinSlug)) : null);
  return {
    email: emailHref && lead.email ? { address: lead.email.trim(), href: emailHref } : null,
    linkedin: linkedinHref ? { href: linkedinHref } : null,
  };
}
