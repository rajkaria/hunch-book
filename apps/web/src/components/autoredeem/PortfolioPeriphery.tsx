"use client";

import type { Address } from "viem";
import type { PortfolioEntry } from "@/lib/market/types";
import { ReferralPanel } from "../referral/ReferralPanel";
import { AutoRedeemPanel } from "./AutoRedeemPanel";

/** The portfolio's periphery panels: auto-redeem (when there are positions) and the referral link. */
export function PortfolioPeriphery({
  entries,
  user,
}: {
  entries: PortfolioEntry[];
  user: Address | undefined;
}) {
  if (!user) return null;
  return (
    <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
      {entries.length > 0 ? <AutoRedeemPanel entries={entries} /> : null}
      <ReferralPanel user={user} />
    </div>
  );
}
