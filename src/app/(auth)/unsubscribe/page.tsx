import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { AuthCardSkeleton } from "../auth-skeleton";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { verifyUnsubscribeToken } from "@/contexts/outreach/email/domain/unsubscribe-token";
import { env } from "@/shared/env";
import { UnsubscribeForm } from "./unsubscribe-form";

export const metadata: Metadata = { title: "Unsubscribe" };

export default function UnsubscribePage({ searchParams }: PageProps<"/unsubscribe">) {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <Unsubscribe searchParams={searchParams} />
    </Suspense>
  );
}

async function Unsubscribe({ searchParams }: { searchParams: PageProps<"/unsubscribe">["searchParams"] }) {
  await connection();
  const { token } = await searchParams;
  const value = typeof token === "string" ? token : "";
  const verified = value ? verifyUnsubscribeToken(env().UNSUBSCRIBE_SECRET, value) : null;
  if (!verified) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h1">Link not valid</CardTitle>
          <CardDescription>This unsubscribe link is invalid or has been altered. Reply to the email and ask to be removed.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return <UnsubscribeForm token={value} email={verified.email} />;
}
