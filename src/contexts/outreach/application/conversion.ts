import type { DbHandle } from "@/platform/db/client";

/**
 * What the lead-to-contact conversion ("Leads and CRM" in docs/decisions.md) needs from outreach. The deals context codes
 * against these types; one composition file wires `drizzle-conversion-outreach.ts` behind them.
 */

/** The campaign behind an enrollment. */
export interface EnrollmentSource {
  campaignId: string;
  name: string;
}

export interface ConversionOutreach {
  /**
   * The person's pending and active enrollments, in every campaign, become `cancelled` with stop reason
   * `converted`, stop being due, and lose the LinkedIn resolve retry time, as removing an enrollment does. Removed, replied,
   * completed and other final rows, other people and other organizations stay as they are. Run it inside the conversion transaction.
   */
  stopPersonEnrollmentsTx(tx: DbHandle, input: { organizationId: string; personId: string; reason: "converted"; now: Date }): Promise<{ stopped: number }>;
  /** Live (pending and active) enrollments per requested person. Every requested id has an entry. */
  liveEnrollmentCounts(organizationId: string, personIds: string[]): Promise<Map<string, number>>;
  /** Person id to the id of the most recently updated enrollment with status `replied` (`updated_at` desc, `id` desc). People without one are absent. */
  latestRepliedEnrollment(organizationId: string, personIds: string[], tx?: DbHandle): Promise<Map<string, string>>;
  /** Enrollment id to its campaign. Ids that do not exist in the organization are absent. */
  enrollmentSources(organizationId: string, enrollmentIds: string[]): Promise<Map<string, EnrollmentSource>>;
}
