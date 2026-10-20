import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkbookView } from "../_components/workbook-view";

export const metadata: Metadata = { title: "Table" };

export default function WorkbookPage({ params }: PageProps<"/tables/[workbookId]">) {
  return (
    <Suspense
      fallback={
        <div className="page">
          <Skeleton className="h-[calc(100svh-2rem)]" />
        </div>
      }
    >
      <Workbook params={params} />
    </Suspense>
  );
}

async function Workbook({ params }: { params: PageProps<"/tables/[workbookId]">["params"] }) {
  await connection();
  const { workbookId } = await params;
  // The view loads through /api/grid, which checks the session and the organization.
  return (
    <Suspense
      fallback={
        <div className="page">
          <Skeleton className="h-[calc(100svh-2rem)]" />
        </div>
      }
    >
      <WorkbookView workbookId={workbookId} />
    </Suspense>
  );
}
