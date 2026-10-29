/**
 * The server side of our JSON API: route handlers wrap their use case in `withActor`, `withAdmin` or `withUser`, which
 * map domain errors to status codes and the error body of `./api-errors.ts`. `./api-client.ts` reads that body in the browser.
 */
import { NextResponse, connection } from "next/server";
import { ZodError } from "zod";
import { apiOrgContext, apiUser, type OrgContext, type SessionUser } from "@/contexts/identity/infrastructure/session";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { apiError } from "./api-errors";
import { ConflictError, ForbiddenError, NotFoundError, PayloadTooLargeError, ValidationError, type Actor } from "@/shared/errors";

export const toActor = (ctx: OrgContext): Actor => ({ userId: ctx.user.id, organizationId: ctx.organization.id, role: ctx.role });

function isInvalidUuid(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "22P02" || code?.cause?.code === "22P02";
}

/**
 * A `Response` from `run` (a CSV file, a redirect) goes out as it is; any other value is the JSON body. An application
 * error becomes the body `{ error, code, ...details }` of `./api-errors.ts`: 403 `forbidden`, 404 `not_found`, 409
 * `conflict`, 413 `payload_too_large`, 422 `validation`, 400 `bad_request`. A 403 or 409 that names its own code keeps it.
 */
async function answer(run: () => Promise<unknown>, status: number): Promise<Response> {
  try {
    const result = await run();
    if (result instanceof Response) return result;
    return result === undefined ? new NextResponse(null, { status: 204 }) : NextResponse.json(result, { status });
  } catch (error) {
    if (error instanceof NotFoundError) return apiError(404, error.message);
    if (error instanceof ForbiddenError) return apiError(403, error.message, ownCode(error));
    if (error instanceof ConflictError) return apiError(409, error.message, error.details);
    if (error instanceof PayloadTooLargeError) return apiError(413, error.message);
    if (error instanceof ValidationError) return apiError(422, error.message, { issues: error.issues });
    if (error instanceof ZodError) return apiError(400, "Invalid input", { issues: error.issues.map((i) => ({ message: `${i.path.join(".")}: ${i.message}` })) });
    if (error instanceof SyntaxError) return apiError(400, "Invalid JSON");
    // A path id that is not a UUID reaches Postgres as 22P02. No row can match it, so it is a 404, not a server error.
    if (isInvalidUuid(error)) return apiError(404, "Not found");
    throw error;
  }
}

/** The `code` a refusal class names for itself, such as `PersonalCampaignError`'s `personal_campaign`. */
function ownCode(error: Error): { code?: string } {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? { code } : {};
}

/** The 401 of a request without a session. */
const unauthenticated = () => apiError(401, "Sign in to continue.");

/** Wraps a route handler: resolves the session and turns application errors into JSON responses. */
export async function withActor(run: (actor: Actor, ctx: OrgContext) => Promise<unknown>, status = 200): Promise<Response> {
  // Every handler reads the session and the database. Without this a GET that takes no request is prerendered at build time.
  await connection();
  const ctx = await apiOrgContext();
  if (!ctx) return unauthenticated();
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
