/**
 * How an application error maps to the JSON API's status, sentence and details. The route wrappers in `./api.ts` turn
 * the result into a response; the MCP wrapper turns it into a tool error. Holds no session or HTTP code, so either can
 * load it.
 */
import { ZodError } from "zod";
import type { ErrorStatus } from "./api-errors";
import { ConflictError, ForbiddenError, NotFoundError, PayloadTooLargeError, ValidationError } from "@/shared/errors";

export interface ClassifiedError {
  status: ErrorStatus;
  message: string;
  details: Record<string, unknown>;
}

function isInvalidUuid(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "22P02" || code?.cause?.code === "22P02";
}

/**
 * 403 `forbidden`, 404 `not_found`, 409 `conflict`, 413 `payload_too_large`, 422 `validation`, 400 `bad_request`. A 409
 * that names its own code keeps it. Null for anything else: the caller treats it as a server error and must not
 * show its message, which can name a table or a query.
 */
export function classifyError(error: unknown): ClassifiedError | null {
  if (error instanceof NotFoundError) return { status: 404, message: error.message, details: {} };
  if (error instanceof ForbiddenError) return { status: 403, message: error.message, details: {} };
  if (error instanceof ConflictError) return { status: 409, message: error.message, details: error.details ?? {} };
  if (error instanceof PayloadTooLargeError) return { status: 413, message: error.message, details: {} };
  if (error instanceof ValidationError) return { status: 422, message: error.message, details: { issues: error.issues } };
  if (error instanceof ZodError) return { status: 400, message: "Invalid input", details: { issues: error.issues.map((i) => ({ message: `${i.path.join(".")}: ${i.message}` })) } };
  if (error instanceof SyntaxError) return { status: 400, message: "Invalid JSON", details: {} };
  // A path id that is not a UUID reaches Postgres as 22P02. No row can match it, so it is a 404, not a server error.
  if (isInvalidUuid(error)) return { status: 404, message: "Not found", details: {} };
  return null;
}
