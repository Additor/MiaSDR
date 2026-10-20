import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/** Request header carrying the path and query, read by identity/infrastructure/session.ts to build a return-to link. */
const REQUEST_PATH_HEADER = "x-miasdr-path";

/** Paths reachable without a session. Everything else needs the Better Auth cookie. */
const PUBLIC_PREFIXES = [
  "/sign-in",
  "/sign-up",
  "/setup",
  "/forgot-password",
  "/reset-password",
  "/accept-invitation",
  "/unsubscribe",
  "/api/outreach/unsubscribe",
  "/api/auth",
  "/api/setup",
  "/api/health",
  // Authenticated by their own secrets, not by a session.
  "/api/jobs/tick",
  "/api/webhooks",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Optimistic gate: checks the cookie exists, not that the session is valid.
 * Pages and route handlers validate the session themselves (see session.ts).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublic(pathname) || getSessionCookie(request)) {
    // Lets a page that finds the session expired send the visitor back to where they were.
    const headers = new Headers(request.headers);
    headers.set(REQUEST_PATH_HEADER, pathname + search);
    return NextResponse.next({ request: { headers } });
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL("/sign-in", request.url);
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
