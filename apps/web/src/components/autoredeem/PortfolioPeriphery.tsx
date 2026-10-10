"use client";

import type { Address } from "viem";
import type { PortfolioEntry } from "@/lib/market/types";
import { ReferralPanel } from "../referral/ReferralPanel";
import { AutoRedeemPanel } from "./AutoRedeemPanel";

/**
 * The portfolio's periphery panels: auto-redeem (when there are positions) and the referral link. The
 * auto-redeemer is the primary stack's, and it redeems only markets of that stack's factory, so it gets
 * those positions; the rest are counted for its note.
 */
export function PortfolioPeriphery({
  entries,
  user,
}: {
  entries: PortfolioEntry[];
  user: Address | undefined;
}) {
  if (!user) return null;
  const covered = entries.filter((e) => (e.market.stack ?? "primary") === "primary");
  const elsewhere = entries.length - covered.length;
  return (
    <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
      {entries.length > 0 ? <AutoRedeemPanel entries={covered} elsewhere={elsewhere} /> : null}
      <ReferralPanel user={user} />
    </div>
  );
}
