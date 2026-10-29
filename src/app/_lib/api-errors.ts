/**
 * The error body of our JSON API: `{ error, code, ...details }` (docs/decisions.md, "API errors and contract types").
 * `error` is a sentence for a person, `code` a stable word the browser branches on. The route wrappers in `./api.ts`, the
 * proxy and the few routes outside the wrappers write it; `./api-client.ts` reads it.
 */
import { NextResponse } from "next/server";

/** The code of each status the API answers with. A 409 keeps the use case's own code when it names one. */
export const STATUS_CODES = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  422: "validation",
  500: "server_error",
} as const;

export type ErrorStatus = keyof typeof STATUS_CODES;

/**
 * Every code a body can carry: one per status, or a refusal's own (`try_again`, `stale_version`, `already_converted`...).
 * The browser names only the codes it branches on.
 */
export type ApiErrorCode = (typeof STATUS_CODES)[ErrorStatus] | (string & {});

/**
 * An error response. `details` adds data such as `issues` or a `version`; a `code` in it replaces the status's code. An
 * `error` key in `details` never replaces the sentence.
 */
export function apiError(status: ErrorStatus, error: string, details: Record<string, unknown> = {}, init?: { headers?: HeadersInit }): NextResponse {
  const code = typeof details.code === "string" ? details.code : STATUS_CODES[status];
  return NextResponse.json({ ...details, error, code }, { status, headers: init?.headers });
}
