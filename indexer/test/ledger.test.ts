// The vault ledger: complete sets, flash loans and the USDC transfers that make up the vault's balance.
import { describe, expect, it } from "vitest";
import { ADDR, ALICE, BOB, CAROL, Protocol, SEED, seedTestnetMarket, USDC } from "./helpers.js";

describe("vault ledger", () => {
  it("mints and merges complete sets, keeping the per-market solvency margin at zero", async () => {
    const p = new Protocol();
    seedTestnetMarket(p);
    p.s.next({ from: ALICE });
    p.mintSets({ market: SEED.market, payer: ALICE, to: ALICE, amount: USDC(10) });
    p.s.next({ from: ALICE });
    p.mergeSets({ market: SEED.market, holder: ALICE, to: BOB, amount: USDC(4) });
    await p.run();

    const market = await p.indexer.Market.getOrThrow(SEED.market);
    expect(market).toMatchObject({
      setsMinted: USDC(10),
      setsMerged: USDC(4),
      vaultSets: USDC(696),
      collateralIn: USDC(700),
      collateralOut: USDC(4),
      solvencyMargin: 0n,
    });
    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${ALICE}`)).toMatchObject({
      setsMinted: USDC(10),
      setsMerged: USDC(4),
      yesBalance: USDC(6),
      noBalance: USDC(6),
      usdcSpent: USDC(10),
      usdcReceived: 0n,
    });
    // The merge paid Bob: the USDC is his, the burned tokens were Alice's.
    expect(await p.indexer.Position.getOrThrow(`${SEED.market}-${BOB}`)).toMatchObject({
      usdcReceived: USDC(4),
      setsMerged: 0n,
    });
    const flows = await p.indexer.SetFlow.getAll();
    expect(flows.map((f) => [f.kind, f.account, f.to, f.amount, f.viaRouter])).toEqual([
      ["Mint", ALICE, ALICE, USDC(10), false],
      ["Merge", ALICE, BOB, USDC(4), false],
    ]);
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      setsMinted: USDC(10),
      setsMerged: USDC(4),
      vaultSets: USDC(696),
      vaultUsdcIn: USDC(700),
      vaultUsdcOut: USDC(4),
      vaultUsdcBalance: USDC(696),
      vaultObligations: USDC(696),
      solvencyMargin: 0n,
    });
  });

  it("treats mints and merges by the router as plumbing", async () => {
    const p = new Protocol();
    seedTestnetMarket(p);
    p.s.next({ from: CAROL });
    p.mintSets({ market: SEED.market, payer: ADDR.router, to: ADDR.router, amount: USDC(5) });
    p.mergeSets({ market: SEED.market, holder: ADDR.router, to: ADDR.router, amount: USDC(5) });
    await p.run();
    const flows = await p.indexer.SetFlow.getAll();
    expect(flows.every((f) => f.viaRouter)).toBe(true);
    expect(await p.indexer.Position.get(`${SEED.market}-${ADDR.router}`)).toBeUndefined();
    expect(await p.indexer.Market.getOrThrow(SEED.market)).toMatchObject({
      vaultSets: USDC(690),
      solvencyMargin: 0n,
    });
  });

  it("counts flash loans and nets their transfers to zero", async () => {
    const p = new Protocol();
    seedTestnetMarket(p);
    p.s.next({ from: BOB });
    p.flashLoan({ receiver: ADDR.router, amount: USDC(2.08) });
    await p.run();
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      flashLoanCount: 1,
      flashLoanVolume: USDC(2.08),
      vaultUsdcIn: USDC(692.08),
      vaultUsdcOut: USDC(2.08),
      vaultUsdcBalance: USDC(690),
      solvencyMargin: 0n,
    });
  });

  it("shows a donation as surplus and ignores USDC transfers that do not touch the vault", async () => {
    const p = new Protocol();
    seedTestnetMarket(p);
    p.s.next({ from: ALICE });
    p.s.emit("Usdc", "Transfer", { from: ALICE, to: ADDR.vault, value: USDC(1) }, ADDR.usdc);
    p.s.emit("Usdc", "Transfer", { from: ALICE, to: BOB, value: USDC(9) }, ADDR.usdc);
    await p.run();
    const stats = await p.indexer.ProtocolStats.getOrThrow("10143");
    expect(stats).toMatchObject({
      vaultUsdcIn: USDC(691),
      vaultUsdcBalance: USDC(691),
      solvencyMargin: USDC(1),
    });
    const usdcEvents = (await p.indexer.VaultEvent.getAll()).filter(
      (e) => e.kind === "UsdcIn" || e.kind === "UsdcOut",
    );
    expect(usdcEvents).toHaveLength(12); // 11 stakes and the donation
  });
});
