"use client";

import { Phase } from "@hunch-book/shared";
import { appNetworkLabel, REPO_URL } from "@/lib/config";
import type { MarketView } from "@/lib/market/types";
import { conditionalOrdersAddress } from "@/lib/orders/hooks";
import { Panel } from "../ui";
import { ClosePosition } from "./ClosePosition";
import { OrderForm } from "./OrderForm";
import { OrderList } from "./OrderList";
import s from "./orders.module.css";

export const ORDERS_DOCS_URL = `${REPO_URL}/blob/main/docs/PERIPHERY.md#conditionalorders`;

/**
 * The market page's order tools once a market trades on its book: close a position in one click, and
 * take-profit, stop-loss and limit-buy orders that wait for a price (ConditionalOrders).
 */
export function OrdersPanel({ m }: { m: MarketView }) {
  if (!m.graduated) return null;
  const contract = conditionalOrdersAddress();
  const trading = m.phase === Phase.Graduated;
  return (
    <Panel
      title="Orders"
      labelledBy="orders-title"
      aside={
        <a className={s.sub} href={ORDERS_DOCS_URL} target="_blank" rel="noreferrer">
          How orders work ↗
        </a>
      }
    >
      {trading ? <ClosePosition m={m} /> : null}
      {contract ? (
        <>
          {trading ? <OrderForm m={m} contract={contract} /> : null}
          <OrderList m={m} contract={contract} />
        </>
      ) : (
        <p className={s.sub}>Conditional orders are not deployed on {appNetworkLabel} yet.</p>
      )}
    </Panel>
  );
}
