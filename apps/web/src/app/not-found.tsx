import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/states";

export const metadata: Metadata = {
  title: "Not found",
  description: "This page does not exist on Hunch Book.",
};

export default function NotFound() {
  return (
    <div className="page">
      <EmptyState label="404" title="This page does not exist">
        <p>
          If you followed a market link, check the address. Every market is listed on{" "}
          <Link href="/markets">the markets page</Link>.
        </p>
      </EmptyState>
    </div>
  );
}
