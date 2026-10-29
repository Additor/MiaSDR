import { EmptyState } from "@/components/shell/empty-state";

/** A missing page outside the app shell. It draws the same `EmptyState` the app's not-found page draws, under its own h1. */
export default function NotFound() {
  return (
    <main className="mx-auto grid min-h-svh w-full max-w-md flex-1 content-center gap-group p-6">
      <h1 className="heading-section">Page not found</h1>
      <EmptyState className="py-0" title="Nothing at this address" description="The page you asked for does not exist, or you no longer have access to it." action={{ label: "Go to the app", href: "/" }} />
    </main>
  );
}
