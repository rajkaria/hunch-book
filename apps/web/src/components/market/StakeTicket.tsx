"use client";

import { marketAbi, Phase, Side } from "@hunch-book/shared";
import { type ReactNode, useState } from "react";
import { type Abi, erc20Abi, maxUint256 } from "viem";
import { appNetworkLabel } from "@/lib/config";
import { chanceComplementBps, formatChance, formatUsdc } from "@/lib/format";
import { queryKeys, useProtocolAddresses, useUsdcState, useUserPosition } from "@/lib/hooks";
import { marketChance, parseUsdcInput, previewStake, validateStake } from "@/lib/market/logic";
import type { MarketView } from "@/lib/market/types";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, useTxRunner } from "@/lib/wallet/useTxRunner";
import { GaslessStake } from "../account/GaslessStake";
import { Button, Panel } from "../ui";
import { ConnectButton } from "../wallet/ConnectButton";
import { LowBalanceFaucet } from "../wallet/Faucet";
import s from "./market.module.css";
import { TradeTicket } from "./TradeTicket";
import { TxList } from "./TxList";

const SIDE_NAME: Record<Side, string> = { [Side.Yes]: "YES", [Side.No]: "NO" };

/** `initialSide` preselects YES or NO, for example when the swipe feed opens the ticket. */
export function StakeTicket({ m, initialSide = Side.Yes }: { m: MarketView; initialSide?: Side }) {
  const open = m.phase === Phase.Pool;
  const [tab, setTab] = useState<"stake" | "trade">(open || !m.graduated ? "stake" : "trade");
  const [side, setSide] = useState<Side>(initialSide);
  const [input, setInput] = useState("");

  const wallet = useAppChain();
  const protocol = useProtocolAddresses();
  const usdc = useUsdcState(wallet.address, protocol.data);
  const position = useUserPosition(m.address, wallet.address);
  const tx = useTxRunner([
    queryKeys.market(m.address),
    queryKeys.usdc(wallet.address ?? "0x"),
    queryKeys.position(m.address, wallet.address ?? "0x"),
    queryKeys.markets(),
  ]);

  const amount = parseUsdcInput(input);
  const chance = marketChance(m);
  const yesBps = chance.source === "pool" && chance.bps !== null ? chance.bps : null;
  const preview =
    amount !== null ? previewStake({ side, amount, yesTotal: m.pool.yes, noTotal: m.pool.no }) : null;
  const problem =
    input.trim() === "" && open
      ? null
      : validateStake({
          amount,
          phase: m.phase,
          caps: m.caps,
          poolTotal: m.pool.total,
          userStake: position.data?.stake ?? null,
          balance: usdc.data?.balance ?? null,
        });
  const needsApproval = Boolean(usdc.data && amount !== null && usdc.data.allowance < amount);

  const approve = async () => {
    if (!protocol.data || !wallet.address) return;
    await tx.run(
      "Approve USDC for the Hunch Book vault",
      {
        address: protocol.data.usdc,
        abi: erc20Abi as Abi,
        functionName: "approve",
        args: [protocol.data.vault, maxUint256],
      },
      wallet.address,
    );
  };

  const stake = async () => {
    if (amount === null || !wallet.address) return;
    const ok = await tx.run(
      `Stake ${formatUsdc(amount)} USDC on ${SIDE_NAME[side]}`,
      { address: m.address, abi: marketAbi as Abi, functionName: "stake", args: [side, amount] },
      wallet.address,
    );
    if (ok) setInput("");
  };

  let action: ReactNode;
  if (!open) {
    action = (
      <Button block disabled>
        Staking is closed
      </Button>
    );
  } else if (!wallet.isConnected) {
    action = (
      <div className={s.steps}>
        <p className={s.laterNote}>Connect a browser wallet to stake.</p>
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
  } else if (!protocol.data || !usdc.data) {
    action = (
      <Button block disabled>
        {protocol.isError || usdc.isError ? "Could not read your USDC" : "Reading your USDC..."}
      </Button>
    );
  } else if (tx.busy) {
    action = (
      <Button block disabled>
        {stageText(tx.stage)}
      </Button>
    );
  } else if (amount === null || problem) {
    action = (
      <Button block disabled>
        Stake
      </Button>
    );
  } else if (needsApproval) {
    action = (
      <div className={s.steps}>
        <Button block variant="primary" onClick={() => void approve()}>
          Step 1 of 2: approve USDC
        </Button>
        <p className={s.laterNote}>
          One approval lets the Hunch Book vault pull USDC when you stake in any market. You can revoke it
          from your wallet at any time.
        </p>
      </div>
    );
  } else {
    action = (
      <Button block variant={side === Side.Yes ? "yes" : "no"} onClick={() => void stake()}>
        Stake {formatUsdc(amount)} USDC on {SIDE_NAME[side]}
      </Button>
    );
  }

  return (
    <Panel title="Ticket" labelledBy="ticket-title" as="section">
      <div className={s.ticketTabs} role="tablist" aria-label="Ticket type">
        <button
          type="button"
          role="tab"
          className={s.ticketTab}
          aria-selected={tab === "stake"}
          onClick={() => setTab("stake")}
        >
          Stake
        </button>
        <button
          type="button"
          role="tab"
          className={s.ticketTab}
          aria-selected={tab === "trade"}
          onClick={() => setTab("trade")}
        >
          Trade
        </button>
      </div>

      {tab === "trade" ? (
        <TradeTicket m={m} initialSide={initialSide} />
      ) : (
        <div role="tabpanel">
          {!open ? (
            <p className={s.validation}>
              {m.graduated
                ? "This pool has graduated. New positions trade on the Kuru book."
                : "This pool has locked. Stakes are final, so it now waits for settlement."}
            </p>
          ) : null}
          <fieldset className={s.sides} style={{ border: 0, padding: 0, margin: "0 0 16px" }}>
            <legend className="visually-hidden">Side</legend>
            {[Side.Yes, Side.No].map((option) => {
              const bps = yesBps === null ? null : option === Side.Yes ? yesBps : chanceComplementBps(yesBps);
              return (
                <button
                  key={option}
                  type="button"
                  className={`${s.sideBtn} ${option === Side.Yes ? s.sideYes : s.sideNo}`}
                  aria-pressed={side === option}
                  onClick={() => setSide(option)}
                  disabled={!open}
                >
                  <span className={s.sideName}>{SIDE_NAME[option]}</span>
                  <span className={s.sideOdds}>
                    {bps === null ? "no stakes yet" : `pool ${formatChance(bps)}`}
                  </span>
                </button>
              );
            })}
          </fieldset>

          <div className={s.field}>
            <label className={s.fieldLabel} htmlFor={`stake-${m.address}`}>
              <span>Amount</span>
              {usdc.data ? <span className="mono">Wallet {formatUsdc(usdc.data.balance)} USDC</span> : null}
            </label>
            <div className={s.inputWrap}>
              <input
                id={`stake-${m.address}`}
                className={s.input}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={!open}
                aria-describedby={`stake-help-${m.address}`}
              />
              <span className={s.inputUnit}>USDC</span>
            </div>
            <p className={s.laterNote} id={`stake-help-${m.address}`}>
              Min {formatUsdc(m.caps.minStake)} USDC. Up to {formatUsdc(m.caps.walletCap)} USDC per wallet.
              Stakes are final: there is no withdrawal from a pool.
            </p>
          </div>

          {problem ? (
            <p className={s.validation} role="status">
              {problem}
            </p>
          ) : null}

          {preview && amount !== null ? (
            <div className={s.preview}>
              <div className={s.previewRow}>
                <span>If {SIDE_NAME[side]} wins you get</span>
                <span className={s.previewValue}>{formatUsdc(preview.paidIfWin)} USDC</span>
              </div>
              <div className={s.previewRow}>
                <span className="muted">Profit after the 2% fee on winnings</span>
                <span className={s.previewValue}>{formatUsdc(preview.profitIfWin)} USDC</span>
              </div>
              <div className={s.previewRow}>
                <span className="muted">If {SIDE_NAME[side === Side.Yes ? Side.No : Side.Yes]} wins</span>
                <span className={s.previewValue}>0.00 USDC</span>
              </div>
              <div className={s.previewRow}>
                <span className="muted">Pool chance of YES after your stake</span>
                <span className={s.previewValue}>{formatChance(preview.chanceAfterBps)}</span>
              </div>
              <p className={s.previewNote}>
                Worked out with the contract's own payout math on the pool as it is now. The payout moves as
                others stake. If the pool graduates, holding your tokens to the end pays the same. If only one
                side has stakes at settlement, every stake is refunded.
              </p>
            </div>
          ) : null}

          {open && wallet.isConnected ? (
            <LowBalanceFaucet balance={usdc.data?.balance ?? null} need={amount} />
          ) : null}
          {action}
          {open ? (
            <GaslessStake
              m={m}
              side={side}
              amount={amount}
              ready={wallet.onAppChain && amount !== null && !problem}
              onDone={() => setInput("")}
            />
          ) : null}
          {tx.error ? (
            <p className={s.txError} role="alert">
              {tx.error}
            </p>
          ) : null}
          <TxList txs={tx.txs} />
        </div>
      )}
    </Panel>
  );
}
