import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCardSkeleton } from "../auth-skeleton";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <ResetPassword searchParams={searchParams} />
    </Suspense>
  );
}

async function ResetPassword({ searchParams }: { searchParams: PageProps<"/reset-password">["searchParams"] }) {
  const { token, error } = await searchParams;
  const valid = typeof token === "string" && token.length > 0 && error !== "INVALID_TOKEN";
  return <ResetPasswordForm token={valid ? token : null} />;
}
