import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { tickObserver } from "@/platform/jobs/observe";
import { registeredJobs } from "@/composition/job-registry";
import { runTick } from "@/platform/jobs/tick";

export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function tick(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const report = await runTick(registeredJobs());
  // The same log lines and failure records as the embedded scheduler. Observing never fails the response.
  await tickObserver.observe(report).catch(() => undefined);
  return NextResponse.json(report);
}

/** External scheduler entry point (cron service, Cloudflare Cron). */
export const POST = tick;

/** Vercel Cron only issues GET. It sends `Authorization: Bearer $CRON_SECRET`, which `authorized` checks. */
export const GET = tick;
