import { createHash } from "node:crypto";
import { fitCompanyText, fitProfileText, type LeadFitProfile } from "./lead-fit";

/**
 * What a judgment read of the profile, as a hash. It covers the text the judgment sends, so an edit to anything else,
 * such as the email, does not ask for a new check. Server only: the lead list's labels live in `lead-fit.ts`.
 */
export const fitProfileHash = (profile: LeadFitProfile): string =>
  createHash("sha256").update(`${fitProfileText(profile)}\n--\n${fitCompanyText(profile)}`).digest("hex").slice(0, 32);
