import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Shown while an auth page resolves its server data, so the HTML response already holds a card. */
export function AuthCardSkeleton({ fields = 2 }: { fields?: number }) {
  return (
    <Card data-skeleton="auth-card" aria-busy="true" aria-label="Loading">
      <CardHeader>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-56" />
      </CardHeader>
      <CardContent className="grid gap-4 py-4">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="grid gap-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </CardContent>
      <CardFooter>
        <Skeleton className="h-9 w-full" />
      </CardFooter>
    </Card>
  );
}
