import { z } from "zod";
import { STEP_SUBJECT_MAX } from "../../domain/campaign";
import { LINKEDIN_STEP_BODY_MAX } from "./linkedin";

/** A LinkedIn step as a route or an agent sends it. The sequence rules are `validateLinkedInSteps`. */
export const linkedinStepSchema = z.object({
  stepNumber: z.number().int(),
  kind: z.enum(["invitation", "message"]),
  subject: z.string().max(STEP_SUBJECT_MAX).optional(),
  body: z.string().max(LINKEDIN_STEP_BODY_MAX),
  waitDays: z.number(),
});
