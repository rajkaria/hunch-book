import type { PositionSide } from "../hedge/math";
import { parseAssetParam, parseSideParam, type QueryLike, queryValue } from "../hedge/prefill";
import { type CustomUnit, type HorizonChoice, parseAmount, type RateBasis, type SizeMode } from "./math";

// The calculator's inputs in its address, so a result can be shared or linked to:
//   /calculator?perp=BTC&side=long&size=10000&unit=usd&horizon=7d&rate=last
// `horizon` is 24h, 7d, or any "<n>h" or "<n>d" for a custom one; `rate` is last (the last interval) or
// 24h (the average over the last 24 hours). Anything malformed is ignored and the default used.

export interface CalculatorInputs {
  asset?: string;
  side?: PositionSide;
  size?: string;
  unit?: SizeMode;
  horizon?: HorizonChoice;
  custom?: string;
  customUnit?: CustomUnit;
  basis?: RateBasis;
}

export function parseCalculatorQuery(query: QueryLike): CalculatorInputs {
  const out: CalculatorInputs = {};
  const asset = parseAssetParam(queryValue(query, "perp"));
  if (asset) out.asset = asset;
  const side = parseSideParam(queryValue(query, "side"));
  if (side) out.side = side;
  const size = queryValue(query, "size");
  if (size && size.length <= 24 && parseAmount(size) !== null) out.size = size;
  const unit = queryValue(query, "unit")?.toLowerCase();
  if (unit === "usd" || unit === "units") out.unit = unit;
  const horizon = queryValue(query, "horizon")?.toLowerCase();
  if (horizon === "24h") out.horizon = "day";
  else if (horizon === "7d") out.horizon = "week";
  else if (horizon) {
    const custom = /^(\d{1,4}(?:\.\d{1,2})?)([hd])$/.exec(horizon);
    if (custom?.[1] && parseAmount(custom[1]) !== null) {
      out.horizon = "custom";
      out.custom = custom[1];
      out.customUnit = custom[2] === "d" ? "days" : "hours";
    }
  }
  const rate = queryValue(query, "rate")?.toLowerCase();
  if (rate === "last") out.basis = "current";
  if (rate === "24h") out.basis = "average";
  return out;
}

/** The calculator's address for a set of inputs, in the same terms parseCalculatorQuery reads. */
export function calculatorUrl(inputs: Required<Pick<CalculatorInputs, "asset">> & CalculatorInputs): string {
  const q = new URLSearchParams({ perp: inputs.asset });
  if (inputs.side) q.set("side", inputs.side);
  if (inputs.size) q.set("size", inputs.size.trim().replace(/,/g, ""));
  if (inputs.unit) q.set("unit", inputs.unit);
  if (inputs.horizon === "day") q.set("horizon", "24h");
  if (inputs.horizon === "week") q.set("horizon", "7d");
  if (inputs.horizon === "custom" && inputs.custom && parseAmount(inputs.custom) !== null) {
    q.set("horizon", `${inputs.custom.trim()}${inputs.customUnit === "days" ? "d" : "h"}`);
  }
  if (inputs.basis) q.set("rate", inputs.basis === "current" ? "last" : "24h");
  return `/calculator?${q.toString()}`;
}
