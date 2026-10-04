import { formatLocal, formatPlusMinus } from "@/lib/create/clock";
import { formatInt, formatUtc } from "@/lib/format";
import s from "./create.module.css";

/**
 * A moment in a market's window: the block (for block-clock markets) and the clock time, in the
 * reader's own zone and in UTC, with how far an estimate could be off.
 */
export function When({
  unix,
  block = null,
  estimated = false,
  plusMinus = null,
}: {
  unix: number | null;
  block?: bigint | null;
  estimated?: boolean;
  plusMinus?: number | null;
}) {
  return (
    <>
      {block !== null ? <span className={s.mono}>Block {formatInt(block)}</span> : null}
      {unix !== null ? (
        <span className={s.estimate}>
          {estimated ? "About " : ""}
          {formatLocal(unix)} ({formatUtc(unix)})
          {estimated && plusMinus !== null ? `, ${formatPlusMinus(plusMinus)}` : ""}
        </span>
      ) : null}
    </>
  );
}
