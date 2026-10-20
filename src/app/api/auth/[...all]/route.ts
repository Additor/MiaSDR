import { toNextJsHandler } from "better-auth/next-js";
import { checkAuthEndpoint } from "@/contexts/identity/domain/auth-endpoint-policy";
import { auth } from "@/contexts/identity/infrastructure/auth";

/** A refused endpoint answers 403 for everyone, signed in or not, so the answer reveals nothing about the account. */
function refuse(request: Request): Response | null {
  const verdict = checkAuthEndpoint(request.method, new URL(request.url).pathname);
  if (verdict.allowed) return null;
  return Response.json({ error: verdict.reason, code: "AUTH_ENDPOINT_NOT_ALLOWED" }, { status: 403 });
}

export function GET(request: Request) {
  return refuse(request) ?? toNextJsHandler(auth()).GET(request);
}

export function POST(request: Request) {
  return refuse(request) ?? toNextJsHandler(auth()).POST(request);
}
