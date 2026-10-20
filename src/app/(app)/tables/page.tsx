import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { TablesBrowser } from "./_components/tables-browser";

export const metadata: Metadata = { title: "Tables" };

export default function TablesPage() {
  return (
    // The browser reads the folder from the URL on the client, so it sits behind Suspense and draws its own top bar,
    // which names the open folder.
    <Suspense
      fallback={
        <>
          <PageHeader title="Tables" />
          <div className="page">
            <Skeleton className="h-64" />
          </div>
        </>
      }
    >
      <TablesBrowser />
    </Suspense>
  );
}
