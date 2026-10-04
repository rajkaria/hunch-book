import { Outcome, Phase, Side } from "@hunch-book/shared";
import { type Address, type Hex, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  approvalsNeeded,
  coverage,
  coverageCounts,
  payingSides,
  type RedeemerState,
} from "../src/lib/autoredeem/coverage";
import { domainMatches, permitDomain, permitTypedData, splitSignature } from "../src/lib/autoredeem/permit";
import type { PortfolioEntry } from "../src/lib/market/types";
import { makeEntry, makeMarket, USDC } from "./fixtures";

const REDEEMER = "0x00000000000000000000000000000000000000ad" as Address;

function graduated(
  over: Partial<PortfolioEntry> = {},
  phase: number = Phase.Graduated,
  outcome: number = Outcome.Unresolved,
) {
  return makeEntry({
    market: makeMarket({ graduated: true, phase: phase as never, outcome: outcome as never }),
    balances: { yes: USDC(10), no: USDC(4) },
    ...over,
  });
}

const state = (optedIn: boolean, markets: RedeemerState["markets"] = new Map()): RedeemerState => ({
  optedIn,
  markets,
});

const key = (e: PortfolioEntry) => e.market.address.toLowerCase();

describe("auto-redeem coverage", () => {
  it("pays the winning side after settlement, both after a void, both held before either", () => {
    expect(payingSides(graduated({}, Phase.Settled, Outcome.Yes))).toEqual([Side.Yes]);
    expect(payingSides(graduated({}, Phase.Settled, Outcome.No))).toEqual([Side.No]);
    expect(payingSides(graduated({}, Phase.Voided))).toEqual([Side.Yes, Side.No]);
    expect(payingSides(graduated({ balances: { yes: 0n, no: USDC(1) } }))).toEqual([Side.No]);
  });

  it("is covered only with the opt-in and an allowance at least the balance on every paying side", () => {
    const e = graduated();
    expect(coverage(e, state(false)).status).toBe("off");
    const short = state(
      true,
      new Map([[key(e), { optedOut: false, allowance: { yes: USDC(10), no: USDC(3) } }]]),
    );
    expect(coverage(e, short)).toMatchObject({ status: "needs-approval", missing: [Side.No] });
    const full = state(
      true,
      new Map([[key(e), { optedOut: false, allowance: { yes: USDC(10), no: USDC(4) } }]]),
    );
    expect(coverage(e, full).status).toBe("covered");
    const out = state(
      true,
      new Map([[key(e), { optedOut: true, allowance: { yes: USDC(10), no: USDC(4) } }]]),
    );
    expect(coverage(e, out).status).toBe("opted-out");
  });

  it("has nothing to do for pools that never graduated or a wallet holding only losing tokens", () => {
    expect(coverage(makeEntry(), state(true)).status).toBe("nothing");
    const lost = graduated({ balances: { yes: USDC(5), no: 0n } }, Phase.Settled, Outcome.No);
    expect(coverage(lost, state(true))).toMatchObject({
      status: "nothing",
      note: "You hold none of the winning side.",
    });
  });

  it("lists every approval still needed, skipping switched-off markets, whether opted in or not", () => {
    const a = graduated();
    const b = graduated({
      market: makeMarket({
        address: "0x00000000000000000000000000000000000000a9",
        graduated: true,
        phase: Phase.Graduated,
      }),
    });
    const s = state(
      false,
      new Map([
        [key(a), { optedOut: false, allowance: { yes: USDC(100), no: 0n } }],
        [key(b), { optedOut: true, allowance: { yes: 0n, no: 0n } }],
      ]),
    );
    expect(approvalsNeeded([a, b], s)).toEqual([
      { market: a.market.address, side: Side.No, token: a.market.tokens.no },
    ]);
    expect(approvalsNeeded([a], null)).toHaveLength(2);
    expect(coverageCounts([a, b, makeEntry()], s)).toEqual({
      covered: 0,
      "needs-approval": 0,
      "opted-out": 0,
      off: 2,
      nothing: 1,
    });
  });
});

describe("outcome token permits", () => {
  const token = "0x00000000000000000000000000000000000000c1" as Address;
  const domain = permitDomain("Hunch Book #1 YES", 10_143, token);

  it("hashes the domain as the Solady token does (separator computed with cast)", () => {
    expect(domainMatches(domain, "0x1009c38d8c0d9a4d98d5efd8c7aa6dba098d1d4e7b2c8710879dd3c781652b49")).toBe(
      true,
    );
    expect(
      domainMatches(
        permitDomain("Hunch Book #1 NO", 10_143, token),
        "0x1009c38d8c0d9a4d98d5efd8c7aa6dba098d1d4e7b2c8710879dd3c781652b49",
      ),
    ).toBe(false);
  });

  it("builds typed data the owner signs, and splits the signature into v, r and s", async () => {
    const owner = privateKeyToAccount(`0x${"11".repeat(32)}` as Hex);
    const data = permitTypedData(domain, {
      owner: owner.address,
      spender: REDEEMER,
      value: 2n ** 256n - 1n,
      nonce: 0n,
      deadline: 1_800_000_000n,
    });
    const signature = await owner.signTypedData(data);
    expect(await recoverTypedDataAddress({ ...data, signature })).toBe(owner.address);
    const { v, r, s } = splitSignature(signature);
    expect([27, 28]).toContain(v);
    expect(r).toBe(signature.slice(0, 66));
    expect(s).toBe(`0x${signature.slice(66, 130)}`);
  });
});
