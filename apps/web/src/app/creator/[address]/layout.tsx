import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { parseAddressParam } from "@/lib/address";

// Validates the address above this segment's loading boundary, so a bad address gets a real 404 status.
export default async function CreatorLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ address: string }>;
}) {
  if (!parseAddressParam((await params).address)) notFound();
  return children;
}
