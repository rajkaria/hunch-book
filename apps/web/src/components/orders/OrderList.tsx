"use client";

import { conditionalOrdersAbi } from "@hunch-book/shared";
import { type Abi, type Address, isAddressEqual } from "viem";
import { formatInt, formatUtc } from "@/lib/format";
import { useBook, useNow } from "@/lib/hooks";
import type { MarketView } from "@/lib/market/types";
import { orderKeys, useOwnerOrders } from "@/lib/orders/hooks";
import {
  describeOrder,
  ORDER_SCAN_LIMIT,
  ORDER_STATE_LABEL,
  type OrderState,
  orderState,
  type StoredOrder,
  triggeredNow,
} from "@/lib/orders/read";
import { peripheryMessage } from "@/lib/periphery";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, useTxRunner } from "@/lib/wallet/useTxRunner";
import ms from "../market/market.module.css";
import { TxList } from "../market/TxList";
import { Badge, Button, type Tone } from "../ui";
import s from "./orders.module.css";

const STATE_TONE: Record<OrderState, Tone> = {
  open: "accent",
  expired: "warn",
  executed: "yes",
  cancelled: "muted",
};

/** History entries shown under "Past orders". */
const HISTORY_SHOWN = 10;

/** The wallet's orders on this market: open ones with cancel, then past ones. */
export function OrderList({ m, contract }: { m: MarketView; contract: Address }) {
  const wallet = useAppChain();
  const now = useNow(5_000);
  const book = useBook(m.book, m.kuruVersion);
  const orders = useOwnerOrders(wallet.address, contract);
  const user = wallet.address;
  const tx = useTxRunner(user ? [orderKeys.owner(user)] : []);

  if (!wallet.isConnected || !user) return null;
  if (orders.isPending) return <p className={s.sub}>Reading your orders...</p>;
  if (orders.isError) {
    return (
      <p className={s.sub} role="status">
        Could not read your orders. They refresh on their own.
      </p>
    );
  }
  const t = now ?? Math.floor(Date.now() / 1000);
  const mine = orders.data.orders.filter((o) => isAddressEqual(o.market, m.address));
  const live = mine.filter((o) => {
    const state = orderState(o, t);
    return state === "open" || state === "expired";
  });
  const past = mine.filter((o) => !live.includes(o)).slice(0, HISTORY_SHOWN);

  const cancel = (o: StoredOrder) =>
    void tx.run(
      `Cancel order #${o.id.toString()}`,
      { address: contract, abi: conditionalOrdersAbi as Abi, functionName: "cancel", args: [o.id] },
      user,
    );

  const row = (o: StoredOrder, withCancel: boolean) => {
    const state = orderState(o, t);
    const { title, detail } = describeOrder(o);
    const hot = triggeredNow(o, book.data ?? null, t);
    return (
      <li className={s.order} key={o.id.toString()}>
        <div className={s.orderHead}>
          <span className={s.orderTitle}>{title}</span>
          <span>
            {hot ? (
              <Badge tone="warn" live>
                Triggered now
              </Badge>
            ) : null}{" "}
            <Badge tone={STATE_TONE[state]} dot>
              {ORDER_STATE_LABEL[state]}
            </Badge>
          </span>
        </div>
        <p className={s.orderDetail}>{detail}</p>
        <div className={s.orderFoot}>
          <span>
            #{o.id.toString()} · {state === "expired" ? "expired" : "expires"} {formatUtc(o.expiry)}
          </span>
          {withCancel ? (
            <Button size="sm" variant="danger" disabled={tx.busy} onClick={() => cancel(o)}>
              {tx.busy ? stageText(tx.stage) : "Cancel"}
            </Button>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <div className={s.section}>
      <div>
        <h3 className={s.heading}>Your orders here</h3>
        <p className={s.sub}>
          {live.length === 0
            ? "No open orders on this market."
            : `${formatInt(live.length)} waiting. An expired order can no longer execute; cancel it to tidy up.`}
        </p>
      </div>
      {live.length > 0 ? <ul className={s.list}>{live.map((o) => row(o, true))}</ul> : null}
      {past.length > 0 ? (
        <details className={s.history}>
          <summary>Past orders ({formatInt(past.length)})</summary>
          <ul className={s.list} style={{ marginTop: 8 }}>
            {past.map((o) => row(o, false))}
          </ul>
        </details>
      ) : null}
      {!orders.data.complete ? (
        <p className={s.sub}>
          Showing orders among the newest {formatInt(ORDER_SCAN_LIMIT)} placed on this network.
        </p>
      ) : null}
      {tx.error ? (
        <p className={ms.txError} role="alert">
          {peripheryMessage(tx.error)}
        </p>
      ) : null}
      <TxList txs={tx.txs} />
    </div>
  );
}
