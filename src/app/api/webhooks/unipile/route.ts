import { NextResponse } from "next/server";
import { receiveUnipileWebhook } from "@/composition/inbox-filing";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Unipile webhook for LinkedIn. The URL carries `?org=<organization id>`, the header `x-unipile-secret`
 * carries the per-organization secret registered with the webhook. Wrong or missing secret: 401.
 * Anything stored (even if processing failed) answers 200, because the replay job owns the retry.
 */
export async function POST(request: Request) {
  const organizationId = new URL(request.url).searchParams.get("org") ?? "";
  if (!UUID.test(organizationId)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const delivery = await receiveUnipileWebhook({ organizationId, secret: request.headers.get("x-unipile-secret"), payload });
  if (delivery.status === 401) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, status: delivery.result.status });
}
