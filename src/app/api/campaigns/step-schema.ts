import { z } from "zod";
import { STEP_BODY_MAX, STEP_SUBJECT_MAX } from "@/contexts/outreach/domain/campaign";

export const stepSchema = z.object({
  stepNumber: z.number().int(),
  kind: z.literal("email"),
  subject: z.string().max(STEP_SUBJECT_MAX).optional(),
  body: z.string().max(STEP_BODY_MAX),
  waitDays: z.number(),
});
