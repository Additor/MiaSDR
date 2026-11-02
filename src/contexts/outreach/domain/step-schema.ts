import { z } from "zod";
import { STEP_BODY_MAX, STEP_SUBJECT_MAX } from "./campaign";

/** An email step as a route or an agent sends it. The sequence rules are `validateSteps`. */
export const stepSchema = z.object({
  stepNumber: z.number().int(),
  kind: z.literal("email"),
  subject: z.string().max(STEP_SUBJECT_MAX).optional(),
  body: z.string().max(STEP_BODY_MAX),
  waitDays: z.number(),
});
