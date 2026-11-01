import { z } from "zod";
import { STEP_SUBJECT_MAX } from "@/contexts/outreach/domain/campaign";
import { LINKEDIN_STEP_BODY_MAX } from "@/contexts/outreach/linkedin/domain/linkedin";

export const linkedinStepSchema = z.object({
  stepNumber: z.number().int(),
  kind: z.enum(["invitation", "message"]),
  subject: z.string().max(STEP_SUBJECT_MAX).optional(),
  body: z.string().max(LINKEDIN_STEP_BODY_MAX),
  waitDays: z.number(),
});
