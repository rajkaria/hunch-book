"use client";

import { conditionalOrdersAbi, Side } from "@hunch-book/shared";
import { type ReactNode, useState } from "react";
import { type Abi, type Address, erc20Abi, maxUint256 } from "viem";
import { appNetworkLabel } from "@/lib/config";
import { formatUsdc } from "@/lib/format";
import { useBook, useChainClock, useNow, useProtocolAddresses, walletQueryKeys } from "@/lib/hooks";
import { parseUsdcInput, windowMoment } from "@/lib/market/logic";
import type { MarketView } from "@/lib/market/types";
import {
  DEFAULT_ORDER_SLIPPAGE_BPS,
  DEFAULT_TIP_BPS,
  EXPIRY_CHOICES,
  EXPIRY_LABEL,
  type ExpiryChoice,
  evaluateOrder,
  isBuyKind,
  ORDER_SLIPPAGE_PRESETS,
  ORDER_TYPE_HELP,
  ORDER_TYPE_LABEL,
  ORDER_TYPES,
  type OrderToken,
  type OrderType,
  orderShape,
  TIP_PRESETS,
  TRIGGER_PRICE_LABEL,
  tipLabel,
} from "@/lib/orders/form";
import { orderKeys, useOrderFunds, useOwnerOrders } from "@/lib/orders/hooks";
import { committedInputs, triggerPriceNow } from "@/lib/orders/read";
import { peripheryMessage } from "@/lib/periphery";
import { formatBps, formatPriceE6 } from "@/lib/trade/ticket";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, useTxRunner } from "@/lib/wallet/useTxRunner";
import ms from "../market/market.module.css";
import { TxList } from "../market/TxList";
import t from "../market/trade.module.css";
import { Button, SegmentedControl } from "../ui";
import { ConnectButton } from "../wallet/ConnectButton";
import s from "./orders.module.css";

const SIDE_NAME: Record<Side, string> = { [Side.Yes]: "YES", [Side.No]: "NO" };
const TOKEN_NAME: Record<OrderToken, string> = { usdc: "USDC", yes: "YES", no: "NO" };

function Chips<T extends string | bigint>({
  label,
  options,
  value,
  onChange,
  render,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  render: (v: T) => string;
}) {
  return (
    <fieldset className={s.group}>
      <legend className={s.groupLabel}>{label}</legend>
      <div className={s.chips}>
        {options.map((o) => (
          <button
            key={String(o)}
            type="button"
            className={s.chip}
            aria-pressed={o === value}
            onClick={() => onChange(o)}
          >
            {render(o)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Take-profit, stop-loss and limit-buy orders on this market, placed with ConditionalOrders. */
export function OrderForm({ m, contract }: { m: MarketView; contract: Address }) {
  const [type, setType] = useState<OrderType>("takeProfit");
  const [side, setSide] = useState<Side>(Side.Yes);
  const [trigger, setTrigger] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [slippageBps, setSlippageBps] = useState(DEFAULT_ORDER_SLIPPAGE_BPS);
  const [tipBps, setTipBps] = useState(DEFAULT_TIP_BPS);
  const [expiry, setExpiry] = useState<ExpiryChoice>("close");
  const [unlimited, setUnlimited] = useState(false);

  const wallet = useAppChain();
  const now = useNow(5_000);
  const clock = useChainClock(m.window.blockClock);
  const book = useBook(m.book);
  const protocol = useProtocolAddresses();
  const funds = useOrderFunds(wallet.address, m);
  const orders = useOwnerOrders(wallet.address);
  const user = wallet.address;
  const tx = useTxRunner([
    ...walletQueryKeys(m, user),
    ...(user ? [orderKeys.owner(user), orderKeys.funds(m.address, user)] : []),
  ]);

  const { kind } = orderShape(type, side);
  const close = windowMoment(m.window, m.window.close, clock);
  const nowSeconds = now ?? Math.floor(Date.now() / 1000);
  const evaluation = evaluateOrder(
    { type, side, trigger, amount: parseUsdcInput(amountInput), slippageBps, tipBps, expiry },
    {
      market: m.address,
      contract,
      phase: m.phase,
      now: nowSeconds,
      closeTime: close?.time ?? null,
      wallet: { connected: wallet.isConnected, onAppChain: wallet.onAppChain },
      balances: funds.data?.balances ?? null,
      allowances: funds.data?.allowances ?? null,
      committed: orders.data
        ? committedInputs(orders.data.orders, m.address, nowSeconds)
        : { usdc: 0n, yes: 0n, no: 0n },
      priceNowE6: book.data ? triggerPriceNow(kind, book.data) : null,
    },
  );
  const priceNow = book.data ? triggerPriceNow(kind, book.data) : null;
  const unit = evaluation.unit;
  const held = funds.data
    ? funds.data.balances[unit === "USDC" ? "usdc" : unit === "YES" ? "yes" : "no"]
    : null;

  const tokenAddress = (token: OrderToken): Address | undefined =>
    token === "usdc" ? protocol.data?.usdc : token === "yes" ? m.tokens.yes : m.tokens.no;

  const approve = () => {
    const approval = evaluation.approval;
    if (!approval || !user) return;
    const token = tokenAddress(approval.token);
    if (!token) return;
    const amount = unlimited ? maxUint256 : approval.amount;
    void tx.run(
      unlimited
        ? `Approve ${TOKEN_NAME[approval.token]} for conditional orders (unlimited)`
        : `Approve ${formatUsdc(approval.amount, { exact: true })} ${TOKEN_NAME[approval.token]} for conditional orders`,
      { address: token, abi: erc20Abi as Abi, functionName: "approve", args: [contract, amount] },
      user,
    );
  };

  const place = async () => {
    if (!evaluation.request || !user) return;
    const ok = await tx.run(
      `Place ${ORDER_TYPE_LABEL[type].toLowerCase()} on ${SIDE_NAME[side]} at ${formatPriceE6(BigInt(evaluation.request.triggerPriceE6))}`,
      {
        address: contract,
        abi: conditionalOrdersAbi as Abi,
        functionName: "place",
        args: [evaluation.request],
      },
      user,
    );
    if (ok) {
      setTrigger("");
      setAmountInput("");
    }
  };

  let action: ReactNode;
  if (!wallet.isConnected) {
    action = (
      <div className={ms.steps}>
        <p className={ms.laterNote}>Connect a browser wallet to place orders.</p>
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
  } else if (evaluation.approval?.needed && evaluation.blocker === null) {
    action = (
      <div className={ms.steps}>
        <Button block variant="primary" onClick={approve}>
          Step 1 of 2:{" "}
          {unlimited
            ? `approve ${TOKEN_NAME[evaluation.approval.token]}`
            : `approve ${formatUsdc(evaluation.approval.amount, { exact: true })} ${TOKEN_NAME[evaluation.approval.token]}`}
        </Button>
        <label className={s.check}>
          <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />
          Approve an unlimited amount, so later orders on {TOKEN_NAME[evaluation.approval.token]} need no new
          approval. Your funds still stay in your wallet until an order executes.
        </label>
        <p className={ms.laterNote}>
          The amount covers this order and your other open ones. The contract can only pull it from you while
          executing one of your own orders.
        </p>
      </div>
    );
  } else {
    action = (
      <Button block variant="primary" disabled={evaluation.request === null} onClick={() => void place()}>
        Place {ORDER_TYPE_LABEL[type].toLowerCase()}
      </Button>
    );
  }

  const triggerId = `order-trigger-${m.address}`;
  const amountId = `order-amount-${m.address}`;

  return (
    <div className={s.section}>
      <div>
        <h3 className={s.heading}>Orders that wait for a price</h3>
        <p className={s.sub}>
          Your funds stay in your wallet until the book reaches your price. Then anyone can execute the order
          and earn its tip; it trades through the Hunch router and pays you at least your minimum.
        </p>
      </div>

      <SegmentedControl
        label="Order type"
        size="sm"
        block
        value={type}
        onChange={setType}
        options={ORDER_TYPES.map((o) => ({ value: o, label: ORDER_TYPE_LABEL[o] }))}
      />
      <p className={s.sub}>{ORDER_TYPE_HELP[type]}</p>

      <SegmentedControl
        label="Side"
        block
        value={side === Side.Yes ? "yes" : "no"}
        onChange={(v) => setSide(v === "yes" ? Side.Yes : Side.No)}
        options={[
          { value: "yes", label: "YES", tone: "yes" },
          { value: "no", label: "NO", tone: "no" },
        ]}
      />

      <div className={ms.field} style={{ marginBottom: 0 }}>
        <label className={ms.fieldLabel} htmlFor={triggerId}>
          <span>Trigger price</span>
          <span className="mono">
            Now {priceNow === null ? (book.data ? "no price" : "reading") : formatPriceE6(priceNow)}
          </span>
        </label>
        <div className={ms.inputWrap}>
          <input
            id={triggerId}
            className={ms.input}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.65"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            aria-invalid={evaluation.errors.trigger ? true : undefined}
            aria-describedby={`${triggerId}-help`}
          />
          <span className={ms.inputUnit}>USDC</span>
        </div>
        <p className={ms.laterNote} id={`${triggerId}-help`}>
          {evaluation.errors.trigger ??
            `Watches ${TRIGGER_PRICE_LABEL[kind]}: it triggers at or ${type === "takeProfit" ? "above" : "below"} this price.`}
        </p>
      </div>

      <div className={ms.field} style={{ marginBottom: 0 }}>
        <label className={ms.fieldLabel} htmlFor={amountId}>
          <span>{isBuyKind(kind) ? (unit === "USDC" ? "Spend" : "Buy") : "Sell"}</span>
          {held !== null ? (
            <span className="mono">
              {unit === "USDC" ? "Wallet" : "You hold"} {formatUsdc(held)} {unit}
            </span>
          ) : null}
        </label>
        <div className={ms.inputWrap}>
          <input
            id={amountId}
            className={ms.input}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            aria-invalid={evaluation.errors.amount ? true : undefined}
            aria-describedby={`${amountId}-help`}
          />
          {!isBuyKind(kind) && held !== null && held > 0n ? (
            <button
              type="button"
              className={t.maxBtn}
              onClick={() => setAmountInput(formatUsdc(held, { exact: true }).replace(/,/g, ""))}
            >
              Max
            </button>
          ) : null}
          <span className={ms.inputUnit}>{unit}</span>
        </div>
        <p className={evaluation.errors.amount ? ms.validation : ms.laterNote} id={`${amountId}-help`}>
          {evaluation.errors.amount ??
            (unit === "USDC"
              ? "USDC to spend on YES when the order executes."
              : isBuyKind(kind)
                ? "NO tokens to buy, exactly. You pay at most the limit below."
                : `${unit} tokens to sell when the order executes.`)}
        </p>
      </div>

      <Chips
        label={
          isBuyKind(kind) && unit === "NO"
            ? "Pay at most this much above the trigger"
            : "Accept down to this much below the trigger"
        }
        options={ORDER_SLIPPAGE_PRESETS}
        value={slippageBps}
        onChange={setSlippageBps}
        render={(v) => formatBps(v)}
      />
      <Chips
        label="Executor tip, paid from your output"
        options={TIP_PRESETS}
        value={tipBps}
        onChange={setTipBps}
        render={tipLabel}
      />
      <Chips
        label="Expires"
        options={EXPIRY_CHOICES}
        value={expiry}
        onChange={setExpiry}
        render={(v) => EXPIRY_LABEL[v]}
      />
      {evaluation.errors.expiry ? <p className={ms.validation}>{evaluation.errors.expiry}</p> : null}

      {evaluation.summary ? (
        <p className={s.summary} aria-live="polite">
          {evaluation.summary}
        </p>
      ) : null}
      {evaluation.warnings.length > 0 ? (
        <ul className={s.warnings}>
          {evaluation.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {evaluation.blocker &&
      !Object.values(evaluation.errors).includes(evaluation.blocker) &&
      (wallet.isConnected || !evaluation.blocker.startsWith("Connect")) ? (
        <p className={ms.laterNote} role="status">
          {evaluation.blocker}
        </p>
      ) : null}

      {action}
      {tx.error ? (
        <p className={ms.txError} role="alert">
          {peripheryMessage(tx.error)}
        </p>
      ) : null}
      <TxList txs={tx.txs} />
    </div>
  );
}
