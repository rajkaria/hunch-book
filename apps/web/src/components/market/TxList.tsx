import { formatInt } from "@/lib/format";
import type { TxRecord } from "@/lib/wallet/useTxRunner";
import { TxLink } from "../ui";
import s from "./market.module.css";

const STATE: Record<TxRecord["status"], { text: string; className?: string }> = {
  pending: { text: "pending" },
  confirmed: { text: "confirmed", className: s.txOk },
  failed: { text: "reverted", className: s.txFail },
};

/** Every transaction this page sent, with its explorer link. */
export function TxList({ txs }: { txs: TxRecord[] }) {
  if (txs.length === 0) return null;
  return (
    <ul className={s.txList} aria-live="polite">
      {txs.map((tx) => (
        <li className={s.tx} key={tx.hash}>
          <span>{tx.label}</span>
          <span>
            <span className={`${s.txState} ${STATE[tx.status].className ?? ""}`}>
              {STATE[tx.status].text}
            </span>{" "}
            <TxLink hash={tx.hash} />
            {tx.includedMs !== undefined ? (
              <span title="Measured in your browser: from your wallet's signature to the receipt.">
                {" "}
                · included in {formatInt(tx.includedMs)} ms
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
