import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/states";
import { ButtonLink } from "@/components/ui";

export const metadata: Metadata = {
  title: "Not found",
  description: "This page does not exist on Hunch Book.",
};

export default function NotFound() {
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <p
        className="display rise-in"
        aria-hidden="true"
        style={{
          margin: "0 0 24px",
          fontSize: "clamp(88px, 22vw, 168px)",
          fontWeight: 800,
          lineHeight: 0.9,
          letterSpacing: "-0.06em",
          color: "var(--accent)",
          textShadow: "0 0 48px rgba(203, 255, 93, 0.25)",
        }}
      >
        404
      </p>
      <EmptyState
        label="Page not found"
        title="This page does not exist"
        titleAs="h1"
        glyph="search"
        actions={
          <>
            <ButtonLink href="/markets" variant="primary" arrow>
              Browse markets
            </ButtonLink>
            <ButtonLink href="/">Go home</ButtonLink>
          </>
        }
      >
        <p>
          If you followed a market link, check the address. Every market is listed on{" "}
          <Link href="/markets">the markets page</Link>.
        </p>
      </EmptyState>
    </div>
  );
}
