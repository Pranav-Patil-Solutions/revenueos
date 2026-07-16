"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Polls router.refresh() while a document is extracting so the review page
 * flips to the grid without a manual reload. */
export function AutoRefresh({ intervalMs = 2000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return null;
}
