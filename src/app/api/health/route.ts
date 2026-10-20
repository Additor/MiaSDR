import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/platform/db/client";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
