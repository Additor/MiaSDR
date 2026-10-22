import { NextResponse } from "next/server";
import { InvalidUnsubscribeToken, unsubscribeByToken } from "@/contexts/outreach/email/application/unsubscribe";
import { unsubscribe } from "@/composition/inbox-filing";

const INVALID = { error: "invalid or expired unsubscribe link" };

/**
 * Public, no session. Two callers:
 * - A mail client (RFC 8058 one-click): POST to the List-Unsubscribe URL with `?token=` and the form body
 *   `List-Unsubscribe=One-Click`. Any other form body is refused.
 * - The confirmation page: JSON `{"token"}`.
 * Both answer 200 and are idempotent: the address is suppressed once and a repeat changes nothing.
 */
export async function POST(request: Request) {
  const queryToken = new URL(request.url).searchParams.get("token");
  let token: string | null = null;
  if (queryToken) {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(await request.text());
      if (form.get("List-Unsubscribe") !== "One-Click") return NextResponse.json(INVALID, { status: 400 });
    }
    token = queryToken;
  } else {
    const body = await request.json().catch(() => null);
    token = typeof body?.token === "string" ? body.token : null;
  }
  if (!token) return NextResponse.json(INVALID, { status: 400 });

  try {
    const { email } = await unsubscribeByToken(unsubscribe(), token);
    return NextResponse.json({ ok: true, email });
  } catch (error) {
    if (error instanceof InvalidUnsubscribeToken) return NextResponse.json(INVALID, { status: 400 });
    throw error;
  }
}
