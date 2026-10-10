"use client";

import { collateralVaultAbi, marketAbi, Outcome, Phase, Side } from "@hunch-book/shared";
import Link from "next/link";
import { useState } from "react";
import { type Abi, erc20Abi } from "viem";
import { appNetworkLabel } from "@/lib/config";
import { formatUsdc } from "@/lib/format";
import {
  useProtocolAddresses,
  useSettlePlan,
  useUserPosition,
  useWalletBalances,
  walletQueryKeys,
} from "@/lib/hooks";
import {
  type ChainHead,
  type Holdings,
  type LifecycleAction,
  lifecycleActions,
  setsAvailability,
  settleGate,
} from "@/lib/market/actions";
import { parseUsdcInput } from "@/lib/market/logic";
import type { SettlePlan } from "@/lib/market/settle";
import type { MarketView } from "@/lib/market/types";
import { vaultOf, venueShort } from "@/lib/stacks";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, type TxStep, useTxRunner } from "@/lib/wallet/useTxRunner";
import { Button, Panel } from "../ui";
import { ConnectButton } from "../wallet/ConnectButton";
import s from "./market.module.css";
import { TxList } from "./TxList";
import t from "./trade.module.css";

const SIDE_NAME: Record<Side, string> = { [Side.Yes]: "YES", [Side.No]: "NO" };
const OUTCOME_NAME: Record<number, string> = { [Outcome.Yes]: "YES", [Outcome.No]: "NO" };

/** The settle button's note and whether the plan lets it send. */
export function settleNote(plan: SettlePlan | undefined, pending: boolean): { ready: boolean; text: string } {
  if (pending || !plan) return { ready: false, text: "Finding the evidence and asking the resolver..." };
  if (plan.status === "ready") {
    const round =
      plan.bracket?.status === "found"
        ? ` It uses Chainlink round ${plan.bracket.round.roundId.toString()}.`
        : "";
    return {
      ready: true,
      text: `The resolver answers ${OUTCOME_NAME[plan.outcome] ?? "?"} with this evidence, so settling now records that outcome.${round}${plan.note ? ` ${plan.note}` : ""}`,
    };
  }
  return { ready: false, text: plan.reason };
}

function steps(m: MarketView, action: LifecycleAction): TxStep[] {
  const market = { address: m.address, abi: marketAbi as Abi };
  switch (action.id) {
    case "graduate":
      return [
        { label: `Graduate the pool to ${venueShort(m)}`, request: { ...market, functionName: "graduate" } },
      ];
    case "claimTokens":
      return [{ label: "Claim YES and NO tokens", request: { ...market, functionName: "claimTokens" } }];
    case "void":
      return [{ label: "Void the market", request: { ...market, functionName: "voidIfExpired" } }];
    case "claimPool":
      return [{ label: "Claim pool payout", request: { ...market, functionName: "claimPool" } }];
    default:
      return [];
  }
}

/** Every lifecycle call this market accepts, enabled only in the right phase, with the reason otherwise. */
export function ActionsPanel({ m, head }: { m: MarketView; head: ChainHead | null }) {
  const wallet = useAppChain();
  const position = useUserPosition(m.address, wallet.address);
  const balances = useWalletBalances(wallet.address, m);
  const protocol = useProtocolAddresses(m);
  const tx = useTxRunner(walletQueryKeys(m, wallet.address));
  const gate = settleGate(m, head);
  const plan = useSettlePlan(m, gate === null);

  const holdings: Holdings | null =
    wallet.address && position.data
      ? {
          claimableTokens: position.data.claimableTokens,
          claimablePool: position.data.claimablePool,
          balances: { yes: balances.data?.yes ?? 0n, no: balances.data?.no ?? 0n },
        }
      : null;
  const actions = lifecycleActions(m, head, holdings);
  const account = wallet.address;
  const canSend = wallet.onAppChain && !tx.busy && Boolean(account);

  const send = (list: TxStep[]) => {
    if (!account || list.length === 0) return;
    void tx.runAll(list, account);
  };

  const buttonFor = (action: LifecycleAction) => {
    if (action.id === "settle") {
      const note = settleNote(plan.data, plan.isPending && gate === null);
      const ready = action.enabled && note.ready && plan.data?.status === "ready";
      return (
        <>
          <Button
            block
            variant={ready ? "primary" : "default"}
            disabled={!ready || !canSend}
            onClick={() =>
              plan.data?.status === "ready" &&
              send([
                {
                  label: `Settle the market (${OUTCOME_NAME[plan.data.outcome] ?? "?"})`,
                  request: {
                    address: m.address,
                    abi: marketAbi as Abi,
                    functionName: "settle",
                    args: [plan.data.evidence],
                  },
                },
              ])
            }
          >
            {action.label}
          </Button>
          <p className={s.laterNote}>{action.enabled ? note.text : action.reason}</p>
        </>
      );
    }
    let list = steps(m, action);
    if (action.id === "redeem" && protocol.data && account) {
      const vault = protocol.data.vault;
      list = (action.redeem ?? []).map((step) => ({
        label: `Redeem ${formatUsdc(step.amount)} ${SIDE_NAME[step.side]} for ${formatUsdc(step.paid)} USDC`,
        request: {
          address: vault,
          abi: collateralVaultAbi as Abi,
          functionName: "redeem",
          args: [m.address, step.side, step.amount, account],
        },
      }));
    }
    return (
      <>
        <Button
          block
          variant={action.enabled ? "primary" : "default"}
          disabled={!action.enabled || !canSend || list.length === 0}
          onClick={() => send(list)}
        >
          {action.label}
        </Button>
        {action.reason ? <p className={s.laterNote}>{action.reason}</p> : null}
      </>
    );
  };

  return (
    <Panel title="Actions" labelledBy="actions-title">
      <ul className={t.actions}>
        {actions.map((action) => (
          <li className={t.action} key={action.id}>
            {buttonFor(action)}
          </li>
        ))}
      </ul>
      {!wallet.isConnected ? (
        <div className={s.steps} style={{ marginTop: 12 }}>
          <p className={s.laterNote}>Anyone can send these. Connect a wallet to send one.</p>
          <ConnectButton />
        </div>
      ) : wallet.wrongNetwork ? (
        <Button
          block
          variant="primary"
          onClick={() => void wallet.switchToAppChain()}
          disabled={wallet.switching}
        >
          {wallet.switching ? "Switching..." : `Switch to ${appNetworkLabel}`}
        </Button>
      ) : null}
      {tx.busy ? (
        <p className={s.laterNote} role="status">
          {stageText(tx.stage)}
          {tx.progress && tx.progress.total > 1 ? ` (${tx.progress.done + 1} of ${tx.progress.total})` : ""}
        </p>
      ) : null}
      {tx.error ? (
        <p className={s.txError} role="alert">
          {tx.error}
        </p>
      ) : null}
      <TxList txs={tx.txs} />
      <p className={s.laterNote} style={{ marginTop: 12 }}>
        {m.phase === Phase.Settled || m.phase === Phase.Voided ? (
          <>
            See exactly what settled it on the <Link href={`/verify/${m.address}`}>verify page</Link>.
          </>
        ) : (
          <>
            Preview what the source says now on the <Link href={`/verify/${m.address}`}>verify page</Link>.
          </>
        )}
      </p>
      {m.graduated ? <SetsSection m={m} /> : null}
    </Panel>
  );
}

/** Mint and merge complete sets on the vault: advanced, collapsed by default. */
export function SetsSection({ m }: { m: MarketView }) {
  const [mintInput, setMintInput] = useState("");
  const [mergeInput, setMergeInput] = useState("");
  const wallet = useAppChain();
  const protocol = useProtocolAddresses(m);
  const balances = useWalletBalances(wallet.address, m);
  const tx = useTxRunner(walletQueryKeys(m, wallet.address));
  const gates = setsAvailability(m);
  const mintAmount = parseUsdcInput(mintInput);
  const mergeAmount = parseUsdcInput(mergeInput);
  const b = balances.data;
  const mergeable = b ? (b.yes < b.no ? b.yes : b.no) : 0n;
  const account = wallet.address;
  const ready = Boolean(account && wallet.onAppChain && protocol.data && b) && !tx.busy;

  let mintProblem: string | null = gates.mint;
  if (!mintProblem && mintAmount !== null && b && mintAmount > b.usdc) {
    mintProblem = `Your wallet holds ${formatUsdc(b.usdc)} USDC.`;
  }
  let mergeProblem: string | null = gates.merge;
  if (!mergeProblem && mergeAmount !== null && mergeAmount > mergeable) {
    mergeProblem = `You can merge up to ${formatUsdc(mergeable)} sets (the smaller of your YES and NO).`;
  }

  const mint = () => {
    if (!account || !protocol.data || mintAmount === null || !b) return;
    const list: TxStep[] = [];
    if (b.allowance.usdcToVault < mintAmount) {
      list.push({
        label: `Approve ${formatUsdc(mintAmount)} USDC for the vault`,
        request: {
          address: protocol.data.usdc,
          abi: erc20Abi as Abi,
          functionName: "approve",
          args: [protocol.data.vault, mintAmount],
        },
      });
    }
    list.push({
      label: `Mint ${formatUsdc(mintAmount)} sets`,
      request: {
        address: protocol.data.vault,
        abi: collateralVaultAbi as Abi,
        functionName: "mintSets",
        args: [m.address, mintAmount, account],
      },
    });
    void tx.runAll(list, account).then((done) => done === list.length && setMintInput(""));
  };

  const merge = () => {
    if (!account || !protocol.data || mergeAmount === null) return;
    void tx
      .runAll(
        [
          {
            label: `Merge ${formatUsdc(mergeAmount)} sets into USDC`,
            request: {
              address: protocol.data.vault,
              abi: collateralVaultAbi as Abi,
              functionName: "mergeSets",
              args: [m.address, mergeAmount, account],
            },
          },
        ],
        account,
      )
      .then((done) => done === 1 && setMergeInput(""));
  };

  return (
    <details className={t.details}>
      <summary>Mint and merge complete sets (advanced)</summary>
      <div className={t.stack}>
        <p className={s.laterNote}>
          One complete set is 1 YES and 1 NO, always backed by exactly 1 USDC in the vault. Minting costs 1
          USDC per set and merging returns 1 USDC per set, with no fee. Makers use this to manage inventory.
        </p>
        <div className={t.pair}>
          <div className={s.field} style={{ marginBottom: 0 }}>
            <label className={s.fieldLabel} htmlFor={`mint-${m.address}`}>
              <span>Mint sets</span>
              {b ? <span className="mono">Wallet {formatUsdc(b.usdc)} USDC</span> : null}
            </label>
            <div className={s.inputWrap}>
              <input
                id={`mint-${m.address}`}
                className={s.input}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={mintInput}
                onChange={(e) => setMintInput(e.target.value)}
                disabled={gates.mint !== null}
              />
              <span className={s.inputUnit}>USDC</span>
            </div>
          </div>
          <Button onClick={mint} disabled={!ready || mintAmount === null || mintProblem !== null}>
            Mint
          </Button>
        </div>
        {mintProblem ? <p className={s.laterNote}>{mintProblem}</p> : null}
        <div className={t.pair}>
          <div className={s.field} style={{ marginBottom: 0 }}>
            <label className={s.fieldLabel} htmlFor={`merge-${m.address}`}>
              <span>Merge sets</span>
              {b ? <span className="mono">Up to {formatUsdc(mergeable)}</span> : null}
            </label>
            <div className={s.inputWrap}>
              <input
                id={`merge-${m.address}`}
                className={s.input}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={mergeInput}
                onChange={(e) => setMergeInput(e.target.value)}
                disabled={gates.merge !== null}
              />
              <span className={s.inputUnit}>sets</span>
            </div>
          </div>
          <Button onClick={merge} disabled={!ready || mergeAmount === null || mergeProblem !== null}>
            Merge
          </Button>
        </div>
        {mergeProblem ? <p className={s.laterNote}>{mergeProblem}</p> : null}
        {!account ? <p className={s.laterNote}>Connect a wallet to mint or merge.</p> : null}
        {tx.busy ? <p className={s.laterNote}>{stageText(tx.stage)}</p> : null}
        {tx.error ? (
          <p className={s.txError} role="alert">
            {tx.error}
          </p>
        ) : null}
        <TxList txs={tx.txs} />
        <p className={s.laterNote}>
          Vault: <span className="mono">{protocol.data?.vault ?? vaultOf(m) ?? "unknown"}</span>
        </p>
      </div>
    </details>
  );
}
