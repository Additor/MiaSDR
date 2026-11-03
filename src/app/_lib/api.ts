/**
 * The server side of our JSON API: route handlers wrap their use case in `withActor`, `withAdmin` or `withUser`, which
 * map domain errors to status codes and the error body of `./api-errors.ts`. `./api-client.ts` reads that body in the browser.
 */
import { headers } from "next/headers";
import { NextResponse, connection } from "next/server";
import { apiOrgContext, apiUser, type OrgContext, type SessionUser } from "@/contexts/identity/infrastructure/session";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { apiError } from "./api-errors";
import { ORGANIZATION_CHANGED, ORGANIZATION_HEADER } from "./api-organization";
import { classifyError } from "./classify-error";
import { ForbiddenError, type Actor } from "@/shared/errors";

export const toActor = (ctx: OrgContext): Actor => ({ userId: ctx.user.id, organizationId: ctx.organization.id, role: ctx.role });

/**
 * A `Response` from `run` (a CSV file, a redirect) goes out as it is; any other value is the JSON body. An application
 * error becomes the body `{ error, code, ...details }` of `./api-errors.ts` through `classifyError`; anything it does
 * not classify is rethrown and answers 500.
 */
async function answer(run: () => Promise<unknown>, status: number): Promise<Response> {
  try {
    const result = await run();
    if (result instanceof Response) return result;
    return result === undefined ? new NextResponse(null, { status: 204 }) : NextResponse.json(result, { status });
  } catch (error) {
    const classified = classifyError(error);
    if (!classified) throw error;
    return apiError(classified.status, classified.message, classified.details);
  }
}

/** The 401 of a request without a session. */
const unauthenticated = () => apiError(401, "Sign in to continue.");

/** Wraps a route handler: resolves the session and turns application errors into JSON responses. */
export async function withActor(run: (actor: Actor, ctx: OrgContext) => Promise<unknown>, status = 200): Promise<Response> {
  // Every handler reads the session and the database. Without this a GET that takes no request is prerendered at build time.
  await connection();
  const ctx = await apiOrgContext();
  if (!ctx) return unauthenticated();
  const rendered = (await headers()).get(ORGANIZATION_HEADER);
  if (rendered && rendered !== ctx.organization.id) return apiError(409, "You switched organization in another tab.", { code: ORGANIZATION_CHANGED });
  return answer(() => run(toActor(ctx), ctx), status);
}

/** `withActor` for routes that work without an organization (a signed-in user with none can still create one). */
export async function withUser(run: (user: SessionUser) => Promise<unknown>, status = 200): Promise<Response> {
  await connection();
  const user = await apiUser();
  if (!user) return unauthenticated();
  return answer(() => run(user), status);
}

/**
 * `withActor` for admin-only handlers. The role check runs before `run`, so a member who sends a malformed body gets 403, not 400.
 * The application functions keep their own check; this one only fixes the order.
 */
export function withAdmin(forbiddenMessage: string, run: (actor: Actor, ctx: OrgContext) => Promise<unknown>, status = 200): Promise<Response> {
  return withActor(async (actor, ctx) => {
    if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError(forbiddenMessage);
    return run(actor, ctx);
  }, status);
}
