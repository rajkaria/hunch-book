"use client";

import { hunchRouterAbi, isBuy, Side, type TradeKind, touchPrice } from "@hunch-book/shared";
import { type ReactNode, useState } from "react";
import { type Abi, type Address, erc20Abi } from "viem";
import { getPublicClient } from "@/lib/chain/client";
import { appNetworkLabel } from "@/lib/config";
import { formatUsdc } from "@/lib/format";
import { useBook, useProtocolAddresses, useWalletBalances, walletQueryKeys } from "@/lib/hooks";
import { parseUsdcInput } from "@/lib/market/logic";
import type { MarketView } from "@/lib/market/types";
import { routerOf } from "@/lib/stacks";
import {
  amountUnit,
  DEFAULT_SLIPPAGE_BPS,
  evaluateTicket,
  formatBps,
  formatPriceE6,
  parseSlippagePercent,
  quoteLines,
  SLIPPAGE_PRESETS,
  TRADE_LABEL,
  type TradeTab,
  tradeDeadline,
  tradeKindOf,
} from "@/lib/trade/ticket";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, useTxRunner } from "@/lib/wallet/useTxRunner";
import { AddressLink, Button } from "../ui";
import { ConnectButton } from "../wallet/ConnectButton";
import { LowBalanceFaucet } from "../wallet/Faucet";
import s from "./market.module.css";
import { TxList } from "./TxList";
import t from "./trade.module.css";

const SIDE_NAME: Record<Side, string> = { [Side.Yes]: "YES", [Side.No]: "NO" };

/** Buy or sell YES or NO on a graduated market's Kuru book, through the Hunch router. */
export function TradeTicket({ m, initialSide = Side.Yes }: { m: MarketView; initialSide?: Side }) {
  const [tab, setTab] = useState<TradeTab>("buy");
  const [side, setSide] = useState<Side>(initialSide);
  const [input, setInput] = useState("");
  const [slippage, setSlippage] = useState<bigint>(DEFAULT_SLIPPAGE_BPS);
  const [custom, setCustom] = useState("");

  const wallet = useAppChain();
  const book = useBook(m.book, m.kuruVersion);
  const protocol = useProtocolAddresses(m);
  const balances = useWalletBalances(wallet.address, m);
  const tx = useTxRunner(walletQueryKeys(m, wallet.address));

  const router = routerOf(m);
  const kind: TradeKind = tradeKindOf(tab, side);
  const unit = amountUnit(kind);
  const amount = parseUsdcInput(input);
  const customBps = custom.trim() === "" ? null : parseSlippagePercent(custom);
  const slippageBps = customBps ?? slippage;
  const state = evaluateTicket({
    kind,
    amount,
    slippageBps,
    phase: m.phase,
    router,
    book: book.data ?? null,
    wallet: { connected: wallet.isConnected, onAppChain: wallet.onAppChain },
    balances: balances.data ?? null,
  });
  const lines = quoteLines(state, slippageBps);
  const held = balances.data
    ? unit === "USDC"
      ? balances.data.usdc
      : unit === "YES"
        ? balances.data.yes
        : balances.data.no
    : null;

  const tokenAddress = (token: "usdc" | "yes" | "no"): Address | undefined =>
    token === "usdc" ? protocol.data?.usdc : token === "yes" ? m.tokens.yes : m.tokens.no;

  const approve = async () => {
    if (!state.approval || !router || !wallet.address) return;
    const token = tokenAddress(state.approval.token);
    if (!token) return;
    const name = state.approval.token === "usdc" ? "USDC" : state.approval.token.toUpperCase();
    await tx.run(
      `Approve ${formatUsdc(state.approval.amount, { exact: true })} ${name} for the Hunch router`,
      {
        address: token,
        abi: erc20Abi as Abi,
        functionName: "approve",
        args: [router, state.approval.amount],
      },
      wallet.address,
    );
  };

  const trade = async () => {
    if (!state.quote || state.limit === null || !router || !wallet.address || amount === null) return;
    // Five minutes from the later of this browser's clock and the chain's, so a slow clock cannot expire it.
    const head = await getPublicClient()
      .getBlock({ blockTag: "latest" })
      .catch(() => null);
    const deadline = tradeDeadline(Math.max(Math.floor(Date.now() / 1000), Number(head?.timestamp ?? 0)));
    const label = `${TRADE_LABEL[kind]}: ${formatUsdc(state.quote.tokens, { exact: true })} ${SIDE_NAME[side]} for ${formatUsdc(state.quote.usdc, { exact: true })} USDC`;
    const ok = await tx.run(
      label,
      {
        address: router,
        abi: hunchRouterAbi as Abi,
        functionName: kind,
        args: [m.address, amount, state.limit, deadline],
      },
      wallet.address,
    );
    if (ok) setInput("");
  };

  const touch = (option: Side): string => {
    if (!book.data) return "reading book";
    const price = touchPrice(tradeKindOf(tab, option), book.data, book.data.params);
    if (price === null) return tab === "buy" ? "no asks" : "no bids";
    return `${tab === "buy" ? "from" : "at"} ${formatPriceE6(price)}`;
  };

  let action: ReactNode;
  if (!wallet.isConnected) {
    action = (
      <div className={s.steps}>
        <Button block disabled>
          {TRADE_LABEL[kind]}
        </Button>
        <p className={s.laterNote}>Connect a browser wallet to trade.</p>
        <ConnectButton />
      </div>
    );
  } else if (wallet.wrongNetwork) {
    action = (
      <Button
        block
        variant="primary"
        onClick={() => void wallet.switchToAppChain()}
        disabled={wallet.switching}
      >
        {wallet.switching ? "Switching..." : `Switch to ${appNetworkLabel}`}
      </Button>
    );
  } else if (tx.busy) {
    action = (
      <Button block disabled>
        {stageText(tx.stage)}
      </Button>
    );
  } else if (state.blocker || !state.approval) {
    action = (
      <Button block disabled>
        {TRADE_LABEL[kind]}
      </Button>
    );
  } else if (state.approval.needed) {
    const name = state.approval.token === "usdc" ? "USDC" : state.approval.token.toUpperCase();
    action = (
      <div className={s.steps}>
        <Button block variant="primary" onClick={() => void approve()}>
          Step 1 of 2: approve {formatUsdc(state.approval.amount, { exact: true })} {name}
        </Button>
        <p className={s.laterNote}>
          The router moves exactly this much for this trade and no more. You approve each trade separately.
        </p>
      </div>
    );
  } else {
    action = (
      <Button block variant={side === Side.Yes ? "yes" : "no"} onClick={() => void trade()}>
        {TRADE_LABEL[kind]}
      </Button>
    );
  }

  const maxable =
    state.max !== null && state.max > 0n && (wallet.isConnected ? balances.data !== undefined : true);

  return (
    <div role="tabpanel" className={t.stack}>
      <div className={t.segment} role="tablist" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            className={t.segmentBtn}
            aria-selected={tab === option}
            onClick={() => setTab(option)}
          >
            {option === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <fieldset className={s.sides} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="visually-hidden">Side</legend>
        {[Side.Yes, Side.No].map((option) => (
          <button
            key={option}
            type="button"
            className={`${s.sideBtn} ${option === Side.Yes ? s.sideYes : s.sideNo}`}
            aria-pressed={side === option}
            aria-label={`${SIDE_NAME[option]} side`}
            onClick={() => setSide(option)}
          >
            <span className={s.sideName}>{SIDE_NAME[option]}</span>
            <span className={s.sideOdds}>{touch(option)}</span>
          </button>
        ))}
      </fieldset>

      <div className={s.field} style={{ marginBottom: 0 }}>
        <label className={s.fieldLabel} htmlFor={`trade-${m.address}`}>
          <span>{kind === "buyYes" ? "Spend" : isBuy(kind) ? "Buy" : "Sell"}</span>
          {held !== null ? (
            <span className="mono">
              {unit === "USDC" ? "Wallet" : "You hold"} {formatUsdc(held)} {unit}
            </span>
          ) : null}
        </label>
        <div className={s.inputWrap}>
          <input
            id={`trade-${m.address}`}
            className={s.input}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-describedby={`trade-help-${m.address}`}
          />
          <button
            type="button"
            className={t.maxBtn}
            disabled={!maxable}
            onClick={() =>
              state.max !== null && setInput(formatUsdc(state.max, { exact: true }).replace(/,/g, ""))
            }
          >
            Max
          </button>
          <span className={s.inputUnit}>{unit}</span>
        </div>
        <p className={s.laterNote} id={`trade-help-${m.address}`}>
          {kind === "buyYes"
            ? "USDC to spend on YES at the asks."
            : kind === "buyNo"
              ? "NO tokens to receive. The router mints them with YES and sells the YES into the bids."
              : kind === "sellYes"
                ? "YES tokens to sell into the bids."
                : "NO tokens to sell. The router buys YES at the asks and merges the pairs into USDC."}
        </p>
      </div>

      <fieldset className={t.fieldset}>
        <legend className={t.label}>Slippage limit</legend>
        <div className={t.slippage}>
          <div className={t.segment}>
            {SLIPPAGE_PRESETS.map((bps) => (
              <button
                key={bps.toString()}
                type="button"
                className={t.segmentBtn}
                aria-pressed={customBps === null && slippage === bps}
                onClick={() => {
                  setSlippage(bps);
                  setCustom("");
                }}
              >
                {formatBps(bps)}
              </button>
            ))}
          </div>
          <div className={t.customWrap}>
            <input
              className={t.customInput}
              inputMode="decimal"
              autoComplete="off"
              placeholder="Custom"
              aria-label="Custom slippage in percent"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <span className={t.customUnit}>%</span>
          </div>
        </div>
        {custom.trim() !== "" && customBps === null ? (
          <p className={t.warn}>Enter a slippage from 0.01% to 50%.</p>
        ) : null}
      </fieldset>

      {lines.length > 0 ? (
        <div className={t.quote} aria-live="polite">
          {lines.map((line) => (
            <div className={t.quoteRow} key={line.label}>
              <span>{line.label}</span>
              <span className={t.quoteValue}>{line.value}</span>
            </div>
          ))}
          <p className={t.note}>
            Quoted from the book at block {book.data?.block.toString() ?? "?"}. The trade is checked against
            the chain before your wallet opens, and it reverts if the price moves past your limit or five
            minutes pass.
          </p>
        </div>
      ) : null}

      {state.blocker && (wallet.isConnected || !state.blocker.startsWith("Connect")) ? (
        <p className={s.validation} role="status" style={{ marginBottom: 0 }}>
          {state.blocker}
        </p>
      ) : null}
      {state.warning ? <p className={t.warn}>{state.warning}</p> : null}

      {isBuy(kind) ? (
        <LowBalanceFaucet
          balance={balances.data?.usdc ?? null}
          need={state.approval?.token === "usdc" ? state.approval.amount : null}
        />
      ) : null}

      {action}
      {tx.error ? (
        <p className={s.txError} role="alert">
          {tx.error}
        </p>
      ) : null}
      <TxList txs={tx.txs} />
      {m.book ? (
        <p className={s.laterNote}>
          Trades go through the Hunch router to this market's Kuru book (<AddressLink address={m.book} />
          ). Some resting orders are from Hunch maker (ours), our own maker bot.
        </p>
      ) : null}
    </div>
  );
}
