/**
 * The server side of our JSON API: route handlers wrap their use case in `withActor`, `withAdmin` or `withUser`, which
 * map domain errors to status codes and one error shape. `./api-client.ts` reads that shape in the browser.
 */
import { NextResponse, connection } from "next/server";
import { ZodError } from "zod";
import { apiOrgContext, apiUser, type OrgContext, type SessionUser } from "@/contexts/identity/infrastructure/session";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ConflictError, ForbiddenError, NotFoundError, PayloadTooLargeError, ValidationError, type Actor } from "@/shared/errors";

export const toActor = (ctx: OrgContext): Actor => ({ userId: ctx.user.id, organizationId: ctx.organization.id, role: ctx.role });

function isInvalidUuid(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "22P02" || code?.cause?.code === "22P02";
}

async function answer(run: () => Promise<unknown>, status: number): Promise<NextResponse> {
  try {
    const result = await run();
    return result === undefined ? new NextResponse(null, { status: 204 }) : NextResponse.json(result, { status });
  } catch (error) {
    if (error instanceof NotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof ForbiddenError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ConflictError) return NextResponse.json({ error: error.message, ...error.details }, { status: 409 });
    if (error instanceof PayloadTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
    if (error instanceof ValidationError) return NextResponse.json({ error: error.message, issues: error.issues }, { status: 422 });
    if (error instanceof ZodError) return NextResponse.json({ error: "Invalid input", issues: error.issues.map((i) => ({ message: `${i.path.join(".")}: ${i.message}` })) }, { status: 400 });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    // A path id that is not a UUID reaches Postgres as 22P02. No row can match it, so it is a 404, not a server error.
    if (isInvalidUuid(error)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw error;
  }
}

/** Wraps a route handler: resolves the session and turns application errors into JSON responses. */
export async function withActor(run: (actor: Actor, ctx: OrgContext) => Promise<unknown>, status = 200): Promise<NextResponse> {
  // Every handler reads the session and the database. Without this a GET that takes no request is prerendered at build time.
  await connection();
  const ctx = await apiOrgContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return answer(() => run(toActor(ctx), ctx), status);
}

/** `withActor` for routes that work without an organization (a signed-in user with none can still create one). */
export async function withUser(run: (user: SessionUser) => Promise<unknown>, status = 200): Promise<NextResponse> {
  await connection();
  const user = await apiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return answer(() => run(user), status);
}

/**
 * `withActor` for admin-only handlers. The role check runs before `run`, so a member who sends a malformed body gets 403, not 400.
 * The application functions keep their own check; this one only fixes the order.
 */
export function withAdmin(forbiddenMessage: string, run: (actor: Actor, ctx: OrgContext) => Promise<unknown>, status = 200): Promise<NextResponse> {
  return withActor(async (actor, ctx) => {
    if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError(forbiddenMessage);
    return run(actor, ctx);
  }, status);
}
