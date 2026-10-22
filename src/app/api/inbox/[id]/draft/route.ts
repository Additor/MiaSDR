import { z } from "zod";
import { createManualDraft, requestDraft } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/app/_lib/api";

/**
 * Without a body, asks the AI for a draft. With `bodyText`, saves a reply a person typed (no AI, no key needed).
 * An empty request body keeps the old "Write a draft" call working; a body that is present must be valid JSON.
 */
const manual = z.object({
  subject: z.string().max(5000).nullable().optional(),
  bodyText: z.string().max(100_000).optional(),
  cc: z.array(z.string().max(320)).max(50).optional(),
});

export async function POST(request: Request, ctx: RouteContext<"/api/inbox/[id]/draft">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const raw = await request.text();
    const body = manual.parse(raw.trim() === "" ? {} : JSON.parse(raw));
    if (body.bodyText === undefined) return requestDraft(replyDeps(), actor, id);
    return createManualDraft(replyDeps(), actor, id, { subject: body.subject, bodyText: body.bodyText, ...(body.cc ? { cc: body.cc } : {}) });
  }, 201);
}
