import { hashPassword } from "better-auth/crypto";
import { NextResponse } from "next/server";
import { apiError } from "@/app/_lib/api-errors";
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
      return apiError(409, error.message, { code: "already_set_up" });
    }
    if (error instanceof ZodError) {
      return apiError(400, error.issues[0]?.message ?? "Invalid input");
    }
    if (error instanceof SyntaxError) {
      return apiError(400, "Invalid input");
    }
    throw error;
  }
}
