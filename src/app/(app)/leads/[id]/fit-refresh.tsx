"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Refreshes the page while a fit check runs on the server, so its verdict shows when it lands. */
export function FitRefresh() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 3_000);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
