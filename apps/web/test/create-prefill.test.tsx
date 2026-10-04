import { Side } from "@hunch-book/shared";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateFlow } from "../src/components/create/CreateFlow";
import { toLocalInput } from "../src/lib/create/clock";
import { parseCreatePrefill } from "../src/lib/create/prefill";
import { renderWithProviders } from "./render";

// A link can hand the create form its values (the hedge assistant's "Create this market").

const NOW = 1_791_090_000;

// One object per read, created once: the form's effects compare data by reference.
const data = vi.hoisted(() => {
  const usdc = (n: number) => BigInt(n) * 1_000_000n;
  const interval = 8_571n;
  const head = { number: 68_036_598n, timestamp: 1_791_090_000 };
  return {
    config: {
      factory: "0x00000000000000000000000000000000000000f1",
      vault: "0x00000000000000000000000000000000000000aa",
      usdc: "0x00000000000000000000000000000000000000ab",
      paused: false,
      caps: { poolCap: usdc(5_000), walletCap: usdc(1_000), minStake: usdc(1), creatorMinStake: usdc(5) },
      templates: {
        1: {
          resolver: "0x00000000000000000000000000000000000000e1",
          rule: { minPool: usdc(500), minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 },
        },
      },
    },
    clock: { head, pace: { msPerBlock: 400, measured: true } },
    perp: {
      info: {
        perpId: 16n,
        name: "BTC Perp",
        symbol: "BTC",
        priceDecimals: 1,
        scalingExp: 0,
        status: 4,
        fundingStartBlock: 12_179_391n,
        markPrice: 850_138n,
      },
      interval,
      anchor: 0n,
      history: {
        interval,
        lastEvent: head.number,
        samples: Array.from({ length: 40 }, (_, i) => ({
          block: head.number - BigInt(39 - i) * interval,
          sum: BigInt(i * 8),
        })),
      },
    },
  };
});

const query = (value: unknown) => ({
  isPending: value === undefined,
  isError: false,
  isFetching: false,
  data: value,
  refetch: vi.fn(),
});

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/config")>();
  return {
    ...actual,
    appDeployment: {
      ...actual.appDeployment,
      hunchBook: { ...actual.appDeployment.hunchBook, factory: "0x00000000000000000000000000000000000000f1" },
    },
  };
});

vi.mock("@/lib/create/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/create/hooks")>();
  return {
    ...actual,
    useCreateConfig: () => query(data.config),
    useCreateClock: () => query(data.clock),
    usePerpContext: () => query(data.perp),
    useChallengeBlocks: () => query(undefined),
    usePreview: () => ({ ...query(undefined), settling: false }),
    useExistingMarket: () => ({ ...query(null), key: null }),
  };
});

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hooks")>();
  return {
    ...actual,
    useNow: () => NOW,
    useUsdcState: () => query(undefined),
    useMarkets: () => query(undefined),
    useTestUsdcFaucet: () => query(undefined),
  };
});

describe("create prefill", () => {
  it("reads only well-formed values", () => {
    expect(
      parseCreatePrefill({
        template: "1",
        asset: "BTC",
        start: "1791100000",
        end: "1791186400",
        threshold: "-13.4",
        side: "NO",
      }),
    ).toEqual({ asset: "BTC", start: 1_791_100_000, end: 1_791_186_400, threshold: "-13.4", side: Side.No });
    expect(parseCreatePrefill({ asset: "DOGE", start: "soon", threshold: "1e5", side: "maybe" })).toEqual({});
    expect(parseCreatePrefill({ asset: ["ETH", "BTC"], side: "yes" })).toEqual({
      asset: "ETH",
      side: Side.Yes,
    });
  });

  it("fills the Perpl form and the first stake's side", async () => {
    const start = 1_791_100_000;
    const end = 1_791_186_400;
    await renderWithProviders(
      <CreateFlow
        initialTemplate={1}
        prefill={{ asset: "BTC", start, end, threshold: "13.4", side: Side.No }}
      />,
    );
    expect((screen.getByRole("radio", { name: "BTC" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Window starts/) as HTMLInputElement).value).toBe(toLocalInput(start));
    expect((screen.getByLabelText(/Window ends/) as HTMLInputElement).value).toBe(toLocalInput(end));
    // The suggested threshold does not overwrite a value the link gave.
    expect((screen.getByLabelText(/Threshold: funding paid by longs/) as HTMLInputElement).value).toBe(
      "13.4",
    );
    expect((screen.getByRole("radio", { name: "NO" }) as HTMLInputElement).checked).toBe(true);
  });
});
