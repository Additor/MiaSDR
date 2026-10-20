import { z } from "zod";

/** Body shapes of the deal routes. The use cases check the meaning (stage of this pipeline, member, currency, amount). */

const amount = z.union([z.string().max(40), z.number()]).nullable().optional();

export const dealFieldsSchema = z.object({
  title: z.string().max(400).nullable().optional(),
  stageId: z.string().max(64).nullable().optional(),
  ownerId: z.string().max(64).nullable().optional(),
  amount,
  currency: z.string().max(8).nullable().optional(),
  expectedCloseOn: z.string().max(20).nullable().optional(),
  lostReason: z.string().max(1000).nullable().optional(),
  idempotencyKey: z.string().max(400).nullable().optional(),
});

export const createForContactSchema = dealFieldsSchema.extend({ personId: z.string().max(64) });

export const updateDealSchema = z.object({
  expectedVersion: z.number().int(),
  title: z.string().max(400).optional(),
  ownerId: z.string().max(64).nullable().optional(),
  amount,
  currency: z.string().max(8).nullable().optional(),
  expectedCloseOn: z.string().max(20).nullable().optional(),
});

export const moveStageSchema = z.object({
  stageId: z.string().max(64),
  expectedVersion: z.number().int(),
  lostReason: z.string().max(1000).nullable().optional(),
});

/** Ids of a bulk call. The use cases cap them (500 per preview); the schema stops a runaway body first. */
export const idsSchema = z.object({ ids: z.array(z.string().max(64)).max(5_000) });

/** Bulk create: the use case takes 200 ids per request and answers 422 with its own message above that. */
export const bulkConvertSchema = idsSchema.extend({
  stageId: z.string().max(64).nullable().optional(),
  ownerId: z.string().max(64).nullable().optional(),
});
