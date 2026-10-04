"use client";

import { autoRedeemerAbi, Side } from "@hunch-book/shared";
import Link from "next/link";
import { useState } from "react";
import { type Abi, type Address, erc20Abi, maxUint256 } from "viem";
import { useSignTypedData } from "wagmi";
import {
  type ApprovalNeed,
  approvalsNeeded,
  type CoverageStatus,
  coverage,
  coverageCounts,
} from "@/lib/autoredeem/coverage";
import { autoRedeemerAddress, useRedeemerState } from "@/lib/autoredeem/hooks";
import {
  domainMatches,
  PERMIT_TTL_SECONDS,
  permitDomain,
  permitTokenAbi,
  permitTypedData,
  splitSignature,
} from "@/lib/autoredeem/permit";
import { getPublicClient } from "@/lib/chain/client";
import { appChain, appNetwork, appNetworkLabel, REPO_URL } from "@/lib/config";
import { formatInt } from "@/lib/format";
import type { PortfolioEntry } from "@/lib/market/types";
import { peripheryMessage } from "@/lib/periphery";
import { isUserRejection } from "@/lib/wallet/network";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, type TxStep, useTxRunner } from "@/lib/wallet/useTxRunner";
import { TxList } from "../market/TxList";
import { marketHeadline } from "../markets/MarketCard";
import { Badge, Button, Panel, type Tone } from "../ui";
import s from "./autoredeem.module.css";

export const AUTO_REDEEM_DOCS_URL = `${REPO_URL}/blob/main/docs/PERIPHERY.md#autoredeemer`;

const STATUS: Record<CoverageStatus, { label: string; tone: Tone }> = {
  covered: { label: "Covered", tone: "accent" },
  "needs-approval": { label: "Needs approval", tone: "warn" },
  "opted-out": { label: "Switched off", tone: "muted" },
  off: { label: "Off", tone: "muted" },
  nothing: { label: "Nothing to redeem", tone: "muted" },
};

const SIDE_NAME: Record<Side, string> = { [Side.Yes]: "YES", [Side.No]: "NO" };

function approveStep(need: ApprovalNeed, redeemer: Address, label: string): TxStep {
  return {
    label: `Approve ${SIDE_NAME[need.side]} on ${label} for auto-redeem`,
    request: {
      address: need.token,
      abi: erc20Abi as Abi,
      functionName: "approve",
      args: [redeemer, maxUint256],
    },
  };
}

/** The portfolio's auto-redeem switch (AutoRedeemer, K-3), and which of the wallet's markets it covers. */
export function AutoRedeemPanel({ entries }: { entries: PortfolioEntry[] }) {
  const redeemer = autoRedeemerAddress();
  const wallet = useAppChain();
  const user = wallet.address;
  const state = useRedeemerState(user, entries);
  const sign = useSignTypedData();
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const tx = useTxRunner(
    user
      ? [
          ["autoredeem", appNetwork],
          ["portfolio", appNetwork],
          ["balances", appNetwork],
        ]
      : [],
  );

  if (!redeemer) {
    return (
      <Panel title="Auto-redeem" labelledBy="autoredeem-title">
        <p className={s.note}>The auto-redeemer is not deployed on {appNetworkLabel} yet.</p>
      </Panel>
    );
  }
  if (!user) return null;

  const graduated = entries.filter((e) => e.market.graduated);
  const data = state.data ?? null;
  const optedIn = data?.optedIn ?? false;
  const needs = approvalsNeeded(entries, data);
  const counts = coverageCounts(entries, data);
  const label = (market: Address): string => {
    const e = entries.find((x) => x.market.address === market);
    return e ? `#${e.market.marketId.toString()}` : "a market";
  };
  const busy = tx.busy || signing;
  const ready = wallet.onAppChain && data !== null && !busy;

  /** Approval and opt-in in one transaction with an EIP-2612 permit, when the token's domain checks out. */
  const permitFirst = async (need: ApprovalNeed): Promise<"done" | "fallback" | "stop"> => {
    try {
      const client = getPublicClient();
      const [name, nonce, separator] = await Promise.all([
        client.readContract({ address: need.token, abi: permitTokenAbi, functionName: "name" }),
        client.readContract({
          address: need.token,
          abi: permitTokenAbi,
          functionName: "nonces",
          args: [user],
        }),
        client.readContract({ address: need.token, abi: permitTokenAbi, functionName: "DOMAIN_SEPARATOR" }),
      ]);
      const domain = permitDomain(name, appChain.id, need.token);
      if (!domainMatches(domain, separator)) return "fallback";
      const deadline = BigInt(Math.floor(Date.now() / 1000) + PERMIT_TTL_SECONDS);
      setSigning(true);
      const signature = await sign.signTypedDataAsync(
        permitTypedData(domain, { owner: user, spender: redeemer, value: maxUint256, nonce, deadline }),
      );
      setSigning(false);
      const { v, r, s: sPart } = splitSignature(signature);
      const ok = await tx.run(
        `Turn on auto-redeem and approve ${SIDE_NAME[need.side]} on ${label(need.market)}`,
        {
          address: redeemer,
          abi: autoRedeemerAbi as Abi,
          functionName: "optInWithPermit",
          args: [need.token, maxUint256, deadline, v, r, sPart],
        },
        user,
      );
      return ok ? "done" : "stop";
    } catch (e) {
      setSigning(false);
      if (isUserRejection(e)) {
        setSignError("You rejected the signature in your wallet.");
        return "stop";
      }
      return "fallback";
    }
  };

  const turnOn = async () => {
    setSignError(null);
    const [first, ...rest] = needs;
    if (first) {
      const result = await permitFirst(first);
      if (result === "stop") return;
      if (result === "done") {
        if (rest.length > 0)
          await tx.runAll(
            rest.map((n) => approveStep(n, redeemer, label(n.market))),
            user,
          );
        return;
      }
    }
    // No permit: the opt-in, then one approval per token.
    await tx.runAll(
      [
        {
          label: "Turn on auto-redeem",
          request: { address: redeemer, abi: autoRedeemerAbi as Abi, functionName: "setOptIn", args: [true] },
        },
        ...needs.map((n) => approveStep(n, redeemer, label(n.market))),
      ],
      user,
    );
  };

  const turnOff = () =>
    void tx.run(
      "Turn off auto-redeem",
      { address: redeemer, abi: autoRedeemerAbi as Abi, functionName: "setOptIn", args: [false] },
      user,
    );

  const cover = () =>
    void tx.runAll(
      needs.map((n) => approveStep(n, redeemer, label(n.market))),
      user,
    );

  const setMarket = (market: Address, optedOut: boolean) =>
    void tx.run(
      optedOut
        ? `Switch off auto-redeem on ${label(market)}`
        : `Switch auto-redeem back on for ${label(market)}`,
      {
        address: redeemer,
        abi: autoRedeemerAbi as Abi,
        functionName: "setMarketOptOut",
        args: [market, optedOut],
      },
      user,
    );

  // Approvals still standing to the auto-redeemer, for "Revoke approvals".
  const standing = graduated.flatMap((e) => {
    const m = data?.markets.get(e.market.address.toLowerCase());
    return [
      ...(m && m.allowance.yes > 0n
        ? [{ token: e.market.tokens.yes, side: Side.Yes, market: e.market.address }]
        : []),
      ...(m && m.allowance.no > 0n
        ? [{ token: e.market.tokens.no, side: Side.No, market: e.market.address }]
        : []),
    ];
  });
  const revoke = () =>
    void tx.runAll(
      standing.map((a) => ({
        label: `Revoke the ${SIDE_NAME[a.side]} approval on ${label(a.market)}`,
        request: { address: a.token, abi: erc20Abi as Abi, functionName: "approve", args: [redeemer, 0n] },
      })),
      user,
    );

  const progress = tx.progress
    ? ` ${Math.min(tx.progress.done + 1, tx.progress.total)} of ${tx.progress.total}`
    : "";
  const error = signError ?? peripheryMessage(tx.error);

  return (
    <Panel
      title="Auto-redeem"
      labelledBy="autoredeem-title"
      aside={
        <a className={s.docs} href={AUTO_REDEEM_DOCS_URL} target="_blank" rel="noreferrer">
          How it works ↗
        </a>
      }
    >
      <div className={s.switchRow}>
        <div>
          <p className={s.title} id="autoredeem-switch-label">
            Redeem my winnings automatically
          </p>
          <p className={s.note}>
            After a market settles, your winning tokens are redeemed and the USDC goes straight to your
            wallet. The auto-redeemer can only redeem, only to you: it cannot sell, move or spend anything
            else.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={optedIn}
          aria-labelledby="autoredeem-switch-label"
          className={s.switch}
          disabled={!ready}
          onClick={() => void (optedIn ? turnOff() : turnOn())}
        >
          <span className={s.knob} aria-hidden="true" />
          <span className="visually-hidden">{optedIn ? "On" : "Off"}</span>
        </button>
      </div>

      {state.isPending ? <p className={s.note}>Reading your setting...</p> : null}
      {state.isError ? (
        <p className={s.note}>Could not read your auto-redeem setting. It refreshes on its own.</p>
      ) : null}
      {wallet.wrongNetwork ? (
        <p className={s.note}>Switch your wallet to {appNetworkLabel} to change it.</p>
      ) : null}
      {busy ? (
        <p className={s.note} role="status">
          {signing ? "Sign the approval in your wallet..." : `${stageText(tx.stage)}${progress}`}
        </p>
      ) : null}

      {data ? (
        <p className={s.summary}>
          {optedIn ? "On. " : "Off. "}
          {formatInt(counts.covered)} {counts.covered === 1 ? "market" : "markets"} covered
          {counts["needs-approval"] > 0
            ? `, ${formatInt(counts["needs-approval"])} waiting for an approval`
            : ""}
          {counts["opted-out"] > 0 ? `, ${formatInt(counts["opted-out"])} switched off` : ""}.
          {!optedIn && needs.length > 0
            ? ` Turning it on takes ${needs.length === 1 ? "one signature and one transaction" : `one signature and ${formatInt(needs.length)} transactions`} (one approval per token you hold).`
            : ""}
        </p>
      ) : null}

      <div className={s.actions}>
        {optedIn && needs.length > 0 ? (
          <Button size="sm" variant="primary" disabled={!ready} onClick={cover}>
            Approve {formatInt(needs.length)} {needs.length === 1 ? "token" : "tokens"} for full cover
          </Button>
        ) : null}
        {standing.length > 0 ? (
          <Button size="sm" variant="ghost" disabled={!ready} onClick={revoke}>
            Revoke approvals
          </Button>
        ) : null}
      </div>

      {graduated.length > 0 ? (
        <ul className={s.list}>
          {graduated.map((e) => {
            const c = coverage(e, data);
            const m = data?.markets.get(e.market.address.toLowerCase());
            const status = STATUS[c.status];
            return (
              <li className={s.item} key={e.market.address}>
                <div className={s.itemHead}>
                  <Link href={`/m/${e.market.address}`} className={s.itemTitle}>
                    {marketHeadline(e.market)}
                  </Link>
                  <Badge tone={status.tone} dot>
                    {status.label}
                  </Badge>
                </div>
                <p className={s.note}>{c.note}</p>
                {optedIn && c.status !== "nothing" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!ready}
                    onClick={() => setMarket(e.market.address, !m?.optedOut)}
                  >
                    {m?.optedOut ? "Include this market" : "Leave this market out"}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={s.note}>
          It covers markets that graduated to a book, where you hold YES or NO tokens. Pools that never
          graduate pay through "Claim pool payout" instead.
        </p>
      )}

      <p className={s.note}>
        Anyone may trigger a redemption for a wallet that opted in, and the USDC always goes to that wallet.
        Hunch's keeper job that runs them after each settlement is building. Turning it off stops new
        redemptions; your approvals stay until you revoke them.
      </p>
      {error ? (
        <p className={s.error} role="alert">
          {error}
        </p>
      ) : null}
      <TxList txs={tx.txs} />
    </Panel>
  );
}
