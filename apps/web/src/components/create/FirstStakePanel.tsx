"use client";

import { Side } from "@hunch-book/shared";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { type Abi, type Address, erc20Abi, type Hex, maxUint256 } from "viem";
import { appNetworkLabel } from "@/lib/config";
import { createKeys } from "@/lib/create/hooks";
import type { CreateConfig } from "@/lib/create/reads";
import { maxFirstStake, nextCreateStep, validateFirstStake } from "@/lib/create/stake";
import { useCreateMarket } from "@/lib/create/useCreateMarket";
import { formatUsdc } from "@/lib/format";
import { queryKeys, useUsdcState } from "@/lib/hooks";
import { parseUsdcInput } from "@/lib/market/logic";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, useTxRunner } from "@/lib/wallet/useTxRunner";
import { TxList } from "../market/TxList";
import { Button, ButtonLink, Field, fieldA11y, Input, Notice, Panel, SegmentedControl, TxLink } from "../ui";
import { ConnectButton } from "../wallet/ConnectButton";
import { LowBalanceFaucet } from "../wallet/Faucet";
import s from "./create.module.css";

/** Seconds on the success screen before the app opens the new market. */
const REDIRECT_SECONDS = 4;

/**
 * Step 3: the creator's first stake, made in the same transaction that creates the market. Approve
 * the vault once (if needed), then `createMarket(templateId, params, side, amount)`, simulated first.
 */
export function FirstStakePanel({
  config,
  templateId,
  params,
  marketKey,
  paramsOk,
  existing,
}: {
  config: CreateConfig;
  templateId: number;
  params: Hex | null;
  marketKey: Hex | null;
  /** The preview ran and the resolver accepts the params. */
  paramsOk: boolean;
  existing: Address | null;
}) {
  const router = useRouter();
  const [side, setSide] = useState<Side>(Side.Yes);
  const [input, setInput] = useState("");
  const wallet = useAppChain();
  const usdc = useUsdcState(wallet.address, { vault: config.vault, usdc: config.usdc });
  const refresh = [
    queryKeys.usdc(wallet.address ?? "0x"),
    queryKeys.markets(),
    createKeys.marketOf(marketKey ?? "0x"),
  ];
  const tx = useTxRunner(refresh);
  const create = useCreateMarket(refresh);
  const [countdown, setCountdown] = useState<number | null>(null);

  const amount = parseUsdcInput(input);
  const balance = usdc.data?.balance ?? null;
  const problem = validateFirstStake({ input, amount, caps: config.caps, balance });
  const step = nextCreateStep({
    connected: wallet.isConnected,
    wrongNetwork: wallet.wrongNetwork,
    ready: Boolean(usdc.data),
    paused: config.paused,
    paramsOk: paramsOk && params !== null && marketKey !== null,
    exists: existing !== null,
    amountOk: amount !== null && problem === null,
    allowance: usdc.data?.allowance ?? null,
    amount,
  });

  // After a successful create, open the new market unless the person stays.
  useEffect(() => {
    if (countdown === null || !create.created) return;
    if (countdown <= 0) {
      router.push(`/m/${create.created.market}`);
      return;
    }
    const id = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1_000);
    return () => clearTimeout(id);
  }, [countdown, create.created, router]);

  const approve = () => {
    if (!wallet.address) return;
    void tx.run(
      "Approve USDC for the Hunch Book vault",
      {
        address: config.usdc,
        abi: erc20Abi as Abi,
        functionName: "approve",
        args: [config.vault, maxUint256],
      },
      wallet.address,
    );
  };

  const submit = async () => {
    if (!wallet.address || !params || !marketKey || amount === null) return;
    const done = await create.run({
      factory: config.factory,
      templateId,
      params,
      side,
      amount,
      key: marketKey,
      account: wallet.address,
    });
    if (done) setCountdown(REDIRECT_SECONDS);
  };

  if (create.created) {
    const href = `/m/${create.created.market}`;
    return (
      <Panel title="Market created" labelledBy="stake-title">
        <div className={s.success} role="status">
          <p>
            Your market is live as a pool, with your first stake of{" "}
            {amount !== null ? formatUsdc(amount) : ""} USDC on {side === Side.Yes ? "YES" : "NO"}.
          </p>
          <p className={s.small}>
            Transaction: <TxLink hash={create.created.hash} />.{" "}
            {countdown !== null && countdown > 0 ? `Opening the market in ${countdown}...` : null}
          </p>
          <div className={s.quick}>
            <ButtonLink href={href} variant="primary" arrow>
              Open the market
            </ButtonLink>
            {countdown !== null && countdown > 0 ? (
              <Button variant="ghost" onClick={() => setCountdown(null)}>
                Stay here
              </Button>
            ) : null}
          </div>
        </div>
      </Panel>
    );
  }

  let action: ReactNode;
  switch (step) {
    case "paused":
      action = (
        <Notice tone="warn" title="Creation is paused">
          <p>The guardian has paused new markets on {appNetworkLabel}. Existing markets are not affected.</p>
        </Notice>
      );
      break;
    case "exists":
      action = (
        <Button block disabled>
          This market already exists
        </Button>
      );
      break;
    case "connect":
      action = (
        <div className={s.actions}>
          <p className={s.small}>Connect a browser wallet to make the first stake.</p>
          <ConnectButton />
        </div>
      );
      break;
    case "switch":
      action = (
        <Button
          block
          variant="primary"
          onClick={() => void wallet.switchToAppChain()}
          loading={wallet.switching}
        >
          Switch to {appNetworkLabel}
        </Button>
      );
      break;
    case "loading":
      action = (
        <Button block disabled>
          {usdc.isError ? "Could not read your USDC" : "Reading your USDC..."}
        </Button>
      );
      break;
    case "fix-params":
      action = (
        <Button block disabled>
          Fix the parameters first
        </Button>
      );
      break;
    case "enter-amount":
      action = (
        <Button block disabled>
          Enter your first stake
        </Button>
      );
      break;
    case "approve":
      action = (
        <div className={s.actions}>
          <Button block variant="primary" onClick={approve} loading={tx.busy}>
            {tx.busy ? stageText(tx.stage) : "Step 1 of 2: approve USDC"}
          </Button>
          <p className={s.small}>
            One approval lets the Hunch Book vault pull USDC when you stake in any market, this one included.
            You can revoke it from your wallet at any time.
          </p>
        </div>
      );
      break;
    default:
      action = (
        <Button
          block
          variant={side === Side.Yes ? "yes" : "no"}
          onClick={() => void submit()}
          loading={create.busy}
        >
          {create.busy
            ? stageText(create.stage)
            : `Create the market with ${amount !== null ? formatUsdc(amount) : ""} USDC on ${side === Side.Yes ? "YES" : "NO"}`}
        </Button>
      );
  }

  const max = maxFirstStake(config.caps);
  return (
    <Panel title="Step 3: first stake" labelledBy="stake-title">
      <div className={s.stake}>
        <p className={s.small}>
          You make the first stake in the same transaction that creates the market. Like every pool stake it
          is final: there is no withdrawal from a pool.
        </p>
        <div>
          <span className={s.groupLabel}>Your side</span>
          <SegmentedControl
            label="Your side"
            name="first-side"
            block
            size="lg"
            value={side === Side.Yes ? "yes" : "no"}
            onChange={(v) => setSide(v === "yes" ? Side.Yes : Side.No)}
            options={[
              { value: "yes", label: "YES", tone: "yes" },
              { value: "no", label: "NO", tone: "no" },
            ]}
          />
        </div>
        <Field
          id="first-stake"
          label="Amount"
          aside={
            balance !== null ? <span className={s.mono}>Wallet {formatUsdc(balance)} USDC</span> : undefined
          }
          hint={`At least ${formatUsdc(config.caps.creatorMinStake)} USDC, at most ${formatUsdc(max)} USDC.`}
          error={problem ?? undefined}
        >
          <Input
            mono
            inputMode="decimal"
            autoComplete="off"
            placeholder={formatUsdc(config.caps.creatorMinStake)}
            unit="USDC"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            {...fieldA11y("first-stake", { hint: true, error: Boolean(problem) })}
          />
        </Field>

        {wallet.isConnected ? <LowBalanceFaucet balance={balance} need={amount} /> : null}

        {action}
        {tx.error ? (
          <p className={s.error} role="alert">
            {tx.error}
          </p>
        ) : null}
        {create.error ? (
          <p className={s.error} role="alert">
            {create.error}
          </p>
        ) : null}
        <TxList txs={create.tx ? [create.tx, ...tx.txs] : tx.txs} />
      </div>
    </Panel>
  );
}
