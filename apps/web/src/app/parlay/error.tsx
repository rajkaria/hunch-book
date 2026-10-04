"use client";

import { RouteError } from "@/components/RouteError";

export default function ParlayError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <RouteError error={error} retry={retry} what="parlays" />;
}
