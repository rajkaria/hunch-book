"use client";

import { hunchRouterAbi, Side } from "@hunch-book/shared";
import { type Abi, type Address, erc20Abi } from "viem";
import { getPublicClient } from "@/lib/chain/client";
import { appDeployment } from "@/lib/config";
import { formatUsdc } from "@/lib/format";
import { useBook, useWalletBalances, walletQueryKeys } from "@/lib/hooks";
import type { MarketView } from "@/lib/market/types";
import { type ClosePlan, closePlan } from "@/lib/orders/close";
import { DEFAULT_SLIPPAGE_BPS, formatBps, tradeDeadline } from "@/lib/trade/ticket";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, useTxRunner } from "@/lib/wallet/useTxRunner";
import ms from "../market/market.module.css";
import { TxList } from "../market/TxList";
import { Button } from "../ui";
import s from "./orders.module.css";

const SIDE_NAME: Record<Side, string> = { [Side.Yes]: "YES", [Side.No]: "NO" };

/**
 * One click to sell the whole YES or NO balance through the router, with a minimum out at the default
 * slippage. If the book cannot take all of it, the button says how much it can. Two steps the first time:
 * an exact approval for the router, then the sale.
 */
export function ClosePosition({ m }: { m: MarketView }) {
  const wallet = useAppChain();
  const book = useBook(m.book);
  const balances = useWalletBalances(wallet.address, m);
  const tx = useTxRunner(walletQueryKeys(m, wallet.address));
  const router = appDeployment.hunchBook.router;

  if (!wallet.isConnected || !wallet.address || !balances.data) return null;
  const ctx = {
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    phase: m.phase,
    router,
    book: book.data ?? null,
    wallet: { connected: wallet.isConnected, onAppChain: wallet.onAppChain },
    balances: balances.data,
  };
  const plans = [closePlan(Side.Yes, ctx), closePlan(Side.No, ctx)].filter((p): p is ClosePlan => p !== null);
  if (plans.length === 0) return null;
  const account = wallet.address;

  const approve = (plan: ClosePlan) => {
    if (!router || !plan.state.approval) return;
    const token: Address = plan.side === Side.Yes ? m.tokens.yes : m.tokens.no;
    void tx.run(
      `Approve ${formatUsdc(plan.amount, { exact: true })} ${SIDE_NAME[plan.side]} for the Hunch router`,
      {
        address: token,
        abi: erc20Abi as Abi,
        functionName: "approve",
        args: [router, plan.state.approval.amount],
      },
      account,
    );
  };

  const close = async (plan: ClosePlan) => {
    if (!router || plan.state.limit === null || !plan.state.quote) return;
    const head = await getPublicClient()
      .getBlock({ blockTag: "latest" })
      .catch(() => null);
    const deadline = tradeDeadline(Math.max(Math.floor(Date.now() / 1000), Number(head?.timestamp ?? 0)));
    await tx.run(
      `Close ${SIDE_NAME[plan.side]}: sell ${formatUsdc(plan.amount, { exact: true })} for ${formatUsdc(plan.state.quote.usdc, { exact: true })} USDC`,
      {
        address: router,
        abi: hunchRouterAbi as Abi,
        functionName: plan.kind,
        args: [m.address, plan.amount, plan.state.limit, deadline],
      },
      account,
    );
  };

  return (
    <div className={s.section}>
      <div>
        <h3 className={s.heading}>Close position</h3>
        <p className={s.sub}>
          Sells your whole balance on the book now, through the Hunch router, with a{" "}
          {formatBps(DEFAULT_SLIPPAGE_BPS)} slippage limit. Nothing is sent until you confirm in your wallet.
        </p>
      </div>
      {plans.map((plan) => {
        const name = SIDE_NAME[plan.side];
        const { state } = plan;
        const blocked = state.blocker !== null || !state.approval || tx.busy;
        return (
          <div className={s.closeRow} key={plan.side}>
            <div className={s.closeHead}>
              <span>
                {name}: <span className={s.mono}>{formatUsdc(plan.held)}</span> held
              </span>
              {state.quote && state.limit !== null ? (
                <span className={s.mono}>
                  about {formatUsdc(state.quote.usdc)} USDC (at least {formatUsdc(state.limit)})
                </span>
              ) : null}
            </div>
            {plan.partial ? (
              <p className={s.sub}>
                The book can take {formatUsdc(plan.amount)} of your {formatUsdc(plan.held)} {name} right now.
                This closes that much; the rest stays in your wallet.
              </p>
            ) : null}
            {state.blocker ? (
              <p className={ms.laterNote} role="status">
                {state.blocker}
              </p>
            ) : null}
            {state.approval?.needed ? (
              <Button size="sm" variant="primary" disabled={blocked} onClick={() => approve(plan)}>
                {tx.busy
                  ? stageText(tx.stage)
                  : `Step 1 of 2: approve ${formatUsdc(plan.amount, { exact: true })} ${name}`}
              </Button>
            ) : (
              <Button
                size="sm"
                variant={plan.side === Side.Yes ? "yes" : "no"}
                disabled={blocked}
                onClick={() => void close(plan)}
              >
                {tx.busy
                  ? stageText(tx.stage)
                  : `Close ${name}${plan.partial ? ` (${formatUsdc(plan.amount)})` : ""}`}
              </Button>
            )}
          </div>
        );
      })}
      {tx.error ? (
        <p className={ms.txError} role="alert">
          {tx.error}
        </p>
      ) : null}
      <TxList txs={tx.txs} />
    </div>
  );
}
