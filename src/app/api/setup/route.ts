import { hashPassword } from "better-auth/crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { SetupAlreadyDoneError, setupInstance } from "@/contexts/tenancy/application/setup-instance";
import { setupDeps } from "@/contexts/tenancy/infrastructure/onboarding-composition";

/** First-run only: creates the admin and organization while no user exists. */
export async function POST(request: Request) {
  try {
    const result = await setupInstance({ ...setupDeps(), hashPassword }, await request.json());
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof SetupAlreadyDoneError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }
    throw error;
  }
}
