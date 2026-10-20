import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-1 flex-col items-start justify-center gap-4 p-6">
      <p className="text-sm text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you asked for does not exist, or you no longer have access to it.</p>
      <Link href="/" className={buttonVariants()}>
        Go to the app
      </Link>
    </main>
  );
}
