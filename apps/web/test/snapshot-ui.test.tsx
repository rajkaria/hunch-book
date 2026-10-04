import { decodeSnapshotParams, encodeSnapshotParams, Outcome, Phase, TemplateId } from "@hunch-book/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotFields } from "../src/components/create/SnapshotForm";
import { ActionsPanel } from "../src/components/market/ActionsPanel";
import { SnapshotPanel } from "../src/components/market/SnapshotPanel";
import { SnapshotReadPanel } from "../src/components/verify/SnapshotReadPanel";
import type { FormResult } from "../src/lib/create/build";
import { parseSource, type SnapshotCheck } from "../src/lib/snapshot";
import { makeMarket } from "./fixtures";
import { renderWithProviders } from "./render";

// Template 7's screens against mocked reads: the create form, the market page's snapshot panel and
// settle button, and the verifier's read.

const RESOLVER = "0x1E62C389D7c035acfDD971C7E6b7157C1D34D632" as Address;
const PERPL = "0x1964C32f0bE608E7D29302AFF5E61268E72080cc" as Address;
const NOW = 1_799_000_000;

type Q = { data?: unknown; isError?: boolean };
const state = vi.hoisted(() => ({
  current: {} as Q,
  sources: {} as Q,
  stored: {} as Q,
  plan: {} as Q,
}));
const q = (s: Q) => ({
  data: s.data,
  isPending: !s.isError && s.data === undefined,
  isError: s.isError ?? false,
  error: s.isError ? new Error("SourceChanged") : null,
  refetch: vi.fn(),
});

vi.mock("@/lib/snapshot/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/snapshot/hooks")>();
  return {
    ...actual,
    useSnapshotSources: () => q(state.sources),
    useSnapshotCurrentValue: () => q(state.current),
    useStoredSnapshot: () => q(state.stored),
  };
});

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hooks")>();
  return { ...actual, useSettlePlan: () => q(state.plan), useNow: () => 1_799_000_000 };
});

const OI = parseSource(0, {
  label: "Perpl's BTC open interest (perp 16)",
  unit: "BTC",
  decimals: 5,
  target: PERPL,
  callData: "0x12345678",
  tuple: true,
  valueWord: 17,
  signed: false,
  timestampWord: 0,
  maxAge: 0,
});
const MARK = {
  ...OI,
  id: 1,
  label: "Perpl's BTC mark price (perp 16)",
  unit: "USD",
  decimals: 1,
  maxAge: 120,
};

const P = {
  sourceId: 0,
  threshold: 2_000_000n,
  comparator: 1 as const,
  lockTime: BigInt(NOW - 3_600),
  closeTime: BigInt(NOW - 60),
  snapshotWindow: 600,
};
const market = makeMarket({
  templateId: TemplateId.Snapshot,
  params: encodeSnapshotParams(P),
  resolver: RESOLVER,
  phase: Phase.Closed,
  window: {
    blockClock: false,
    lock: P.lockTime,
    close: P.closeTime,
    settleDeadline: P.closeTime + 600n + 604_800n,
  },
});

beforeEach(() => {
  state.current = { data: 2_357_534n };
  state.sources = { data: [OI, MARK] };
  state.stored = { data: { key: `0x${"11".repeat(32)}`, snapshot: null } };
  state.plan = {};
});

describe("create: template 7 form", () => {
  it("lists the resolver's sources, shows the current value and starts the level from it", async () => {
    const onResult = vi.fn<(r: FormResult) => void>();
    await renderWithProviders(
      <SnapshotFields now={NOW} resolver={RESOLVER} sources={[OI, MARK]} onResult={onResult} />,
    );
    expect(screen.getByRole("radio", { name: /Perpl's BTC open interest \(perp 16\)/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /mark price.*refused if older than 120 seconds/ })).toBeTruthy();
    expect(screen.getByText("23.57534 BTC")).toBeTruthy();
    const level = screen.getByLabelText(/Level, in BTC/) as HTMLInputElement;
    await waitFor(() => expect(level.value).toBe("23.6"));
    await waitFor(() => expect(onResult.mock.calls.at(-1)?.[0].params).not.toBeNull());
    const params = decodeSnapshotParams(onResult.mock.calls.at(-1)?.[0].params as Hex);
    expect(params).toMatchObject({ sourceId: 0, threshold: 2_360_000n, comparator: 0, snapshotWindow: 600 });

    fireEvent.click(screen.getByRole("radio", { name: "at or below" }));
    fireEvent.click(screen.getByRole("radio", { name: "30 minutes" }));
    fireEvent.change(level, { target: { value: "25" } });
    await waitFor(() =>
      expect(decodeSnapshotParams(onResult.mock.calls.at(-1)?.[0].params as Hex)).toMatchObject({
        threshold: 2_500_000n,
        comparator: 3,
        snapshotWindow: 1_800,
      }),
    );
  });

  it("says when the resolver refuses to read a source", async () => {
    state.current = { isError: true };
    await renderWithProviders(
      <SnapshotFields now={NOW} resolver={RESOLVER} sources={[OI]} onResult={vi.fn()} />,
    );
    expect(screen.getByText(/^The resolver refuses to read this source now/)).toBeTruthy();
  });
});

describe("market page: snapshot panel and settle button", () => {
  it("shows the source, the rule, the open window and the value now", async () => {
    await renderWithProviders(<SnapshotPanel m={market} now={NOW} />);
    expect(screen.getByText("Perpl's BTC open interest (perp 16)")).toBeTruthy();
    expect(screen.getByText("at or above 20 BTC")).toBeTruthy();
    expect(screen.getByText("Open now")).toBeTruthy();
    expect(screen.getByText("23.57534 BTC")).toBeTruthy();
    expect(screen.getByText(/Settling now takes the snapshot and settles in one transaction/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Check it on the verify page" }).getAttribute("href")).toBe(
      `/verify/${market.address}`,
    );
  });

  it("shows the stored snapshot with its block once taken", async () => {
    state.stored = {
      data: {
        key: `0x${"11".repeat(32)}`,
        snapshot: { value: 2_500_000n, blockNumber: 68_000_000n, timestamp: BigInt(NOW - 50) },
      },
    };
    await renderWithProviders(<SnapshotPanel m={market} now={NOW} />);
    expect(screen.getByText("25 BTC")).toBeTruthy();
    expect(screen.getByRole("link", { name: "68,000,000" })).toBeTruthy();
    expect(screen.getByText(/The snapshot is taken and final/)).toBeTruthy();
  });

  it("renders nothing for other templates", async () => {
    const r = await renderWithProviders(<SnapshotPanel m={makeMarket()} now={NOW} />);
    expect(r.container.textContent).toBe("");
  });

  it("offers settle with empty evidence and says it takes the snapshot", async () => {
    state.plan = {
      data: {
        status: "ready",
        evidence: "0x",
        outcome: Outcome.Yes,
        evidenceHash: `0x${"ab".repeat(32)}`,
        bracket: null,
        note: "Settling now takes the snapshot and settles in one transaction. The window closes at x.",
      },
    };
    await renderWithProviders(<ActionsPanel m={market} head={{ block: 68_000_000n, time: NOW }} />, {
      connected: true,
    });
    expect(
      screen.getByText(/The resolver answers YES with this evidence.*Settling now takes the snapshot/),
    ).toBeTruthy();
  });
});

describe("verifier: snapshot read", () => {
  const check: SnapshotCheck = {
    template: "snapshot",
    params: P,
    key: `0x${"11".repeat(32)}`,
    source: OI,
    snapshot: { value: 2_500_000n, blockNumber: 68_000_000n, timestamp: BigInt(NOW - 50) },
    window: "after",
    outcome: Outcome.Yes,
    expectedHash: `0x${"cd".repeat(32)}`,
    reread: { value: 2_500_000n, matches: true, error: null },
    current: null,
  };

  it("shows the call, the stored snapshot, the rule and the re-read", async () => {
    await renderWithProviders(<SnapshotReadPanel read={check} />);
    expect(screen.getByText("Perpl's BTC open interest (perp 16), in BTC")).toBeTruthy();
    expect(screen.getByText("word 17 of the returned tuple, unsigned")).toBeTruthy();
    expect(screen.getByText("Closed")).toBeTruthy();
    expect(screen.getAllByText("25 BTC (raw 2500000)")).toHaveLength(2);
    expect(screen.getByText("YES")).toBeTruthy();
    expect(screen.getByText("Match")).toBeTruthy();
  });

  it("marks a re-read that differs", async () => {
    await renderWithProviders(
      <SnapshotReadPanel read={{ ...check, reread: { value: 2_500_001n, matches: false, error: null } }} />,
    );
    expect(screen.getByText("Differs")).toBeTruthy();
  });
});
