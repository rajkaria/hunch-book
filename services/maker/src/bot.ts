import {
  chainsByNetwork,
  collateralVaultAbi,
  type Deployment,
  loadDeployment,
  Outcome,
  PHASE_LABEL,
  Phase,
  Side,
} from "@hunch-book/shared";
import {
  type Account,
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  isAddressEqual,
  type PublicClient,
  parseGwei,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { MakerConfig } from "./config.js";
import { MarketDirectory, type MarketView, secondsToClose } from "./discovery.js";
import { type ChainNow, type FairResult, FairValues, NoModelError, PRICED_TEMPLATES } from "./fair.js";
import { Health } from "./health.js";
import { vaultSetOps } from "./inventory.js";
import { readBookInfo } from "./kuru.js";
import { errorMessage, log } from "./log.js";
import {
  cancelBook,
  cancelMarket,
  createRuntime,
  type MakerDeps,
  type MarketRuntime,
  quoteMarket,
  unwindMarket,
} from "./maker.js";
import { PaperDesk } from "./paperDesk.js";
import { widenFactor } from "./quotes.js";
import { rateLimitedFetch } from "./rpc.js";
import { accountAddress, sendTx, type TxContext } from "./tx.js";

// The long-running bot: discovers markets, prices them, quotes graduated ones, and leaves each market
// before close. Everything it sends goes through sendTx, which honours the kill switch.

const LOW_MON = 500_000_000_000_000_000n; // 0.5 MON

export class Maker {
  readonly deployment: Deployment;
  readonly client: PublicClient;
  readonly tx: TxContext;
  readonly deps: MakerDeps;
  readonly health: Health;
  private readonly fair: FairValues;
  private readonly directory: MarketDirectory | undefined;
  private readonly runtimes = new Map<Address, MarketRuntime>();
  private readonly settledChecked = new Set<Address>();
  /** Markets not quoted, and why, logged once each. */
  private readonly skipped = new Set<string>();
  /** Paper mode (MAKER_MODE=paper): simulated orders, fills and account. Undefined when live. */
  readonly paper: PaperDesk | undefined;
  private lastPaperLog = "";
  private blockSeconds = 0.4;
  private blockSecondsAt = 0;

  /** `deployment` defaults to deployments/<network>.json; tests pass one with their own addresses. */
  constructor(
    readonly config: MakerConfig,
    deployment: Deployment = loadDeployment(config.network),
  ) {
    this.deployment = deployment;
    const chain = chainsByNetwork[config.network];
    const transport = http(config.rpcUrl, {
      retryCount: 5,
      retryDelay: 500,
      timeout: 20_000,
      fetchFn: rateLimitedFetch(config.rpcRequestsPerSecond),
    });
    this.client = createPublicClient({ chain, transport }) as PublicClient;
    const account: Account | Address = config.privateKey
      ? privateKeyToAccount(config.privateKey)
      : this.deployment.wallets.maker;
    const walletClient =
      typeof account === "string" ? undefined : createWalletClient({ account, chain, transport });
    this.tx = {
      publicClient: this.client,
      walletClient,
      account,
      chain,
      deployment: this.deployment,
      enabled: config.enabled,
      maxGasPriceWei: parseGwei(String(config.maxGasPriceGwei)),
      maxGasPerTx: config.maxGasPerTx,
    };
    this.deps = {
      tx: this.tx,
      marginAccount: this.deployment.external.kuru.marginAccount,
      quote: config.quote,
      requoteThreshold: config.requoteThreshold,
      heartbeatSeconds: config.heartbeatSeconds,
      dustTokens: config.dustTokens,
    };
    this.fair = new FairValues(this.client, this.deployment);
    this.paper =
      config.mode === "paper" ? new PaperDesk(this.client, this.deps, config.paperUsdc) : undefined;
    const factory = this.deployment.hunchBook.factory;
    this.directory = factory ? new MarketDirectory(this.client, factory, config.markets) : undefined;
    this.health = new Health(config.healthFile, {
      network: config.network,
      maker: accountAddress(this.tx),
      enabled: config.enabled,
      mode: config.mode,
    });
  }

  get maker(): Address {
    return accountAddress(this.tx);
  }

  /** Warns when the address the bot runs as is not the one published in deployments/<network>.json. */
  checkPublishedAddress(): void {
    if (this.paper) return;
    if (!isAddressEqual(this.maker, this.deployment.wallets.maker)) {
      // Not Hunch Book's maker: an outside maker running the kit with its own key, which is the point
      // of the kit. Its fills count as outside liquidity; only wallets.maker is labelled as Hunch's.
      log("outside-maker", {
        maker: this.maker,
        hunchMaker: this.deployment.wallets.maker,
        note: "this address is not Hunch Book's published maker (wallets.maker): its fills count as outside liquidity on the proof page",
      });
    }
  }

  private async now(): Promise<ChainNow> {
    const block = await this.client.getBlock();
    const now = { block: Number(block.number), timestamp: Number(block.timestamp) };
    if (now.timestamp - this.blockSecondsAt > 3_600) {
      const span = 20_000n;
      if (block.number > span) {
        const earlier = await this.client.getBlock({ blockNumber: block.number - span });
        const measured = Number(block.timestamp - earlier.timestamp) / Number(span);
        if (measured > 0) this.blockSeconds = measured;
      }
      this.blockSecondsAt = now.timestamp;
    }
    return now;
  }

  private async runtimeFor(market: MarketView): Promise<MarketRuntime | undefined> {
    const existing = this.runtimes.get(market.address);
    if (existing) return existing;
    const info = await readBookInfo(this.client, market.book);
    const vaultUsdc = await this.client.readContract({
      address: market.vault,
      abi: collateralVaultAbi,
      functionName: "usdc",
    });
    if (!isAddressEqual(info.base, market.yes) || !isAddressEqual(info.quote, vaultUsdc)) {
      log(
        "book-mismatch",
        { market: market.address, book: market.book, base: info.base, quote: info.quote },
        "error",
      );
      return undefined;
    }
    if (info.baseDecimals !== info.quoteDecimals) {
      log("book-mismatch", { market: market.address, reason: "YES and USDC decimals differ" }, "error");
      return undefined;
    }
    const ceiling = BigInt(Math.ceil(this.config.quote.inventoryCap * 2)) * 10n ** BigInt(info.quoteDecimals);
    const rt = createRuntime({
      market: market.address,
      book: market.book,
      info,
      no: market.no,
      sets: vaultSetOps(this.tx, market.vault, market.address, info.quote, ceiling),
    });
    this.runtimes.set(market.address, rt);
    return rt;
  }

  /** One pass over every market. Errors in one market never stop the others. */
  async cycle(): Promise<void> {
    if (!this.directory) {
      log(
        "idle",
        { reason: `hunchBook.factory is not in deployments/${this.config.network}.json yet` },
        "warn",
      );
      this.health.update({ lastCycleAt: new Date().toISOString(), lastError: "factory not deployed" });
      return;
    }
    const now = await this.now();
    const wall = Math.floor(Date.now() / 1000);
    const markets = await this.directory.refresh();
    for (const market of markets) {
      if (market.book === zeroAddress) continue;
      try {
        await this.handle(market, now, wall);
      } catch (error) {
        const message = errorMessage(error);
        log("market-error", { market: market.address, book: market.book, error: message }, "error");
        const rt = this.runtimes.get(market.address);
        if (rt) rt.health = { ...rt.health, status: "error", error: message };
      }
    }
    if (this.paper) {
      // Paper mode: no wallet to check; report the paper account instead.
      const report = this.paper.report();
      const line = `${report.fills}:${report.value}`;
      if (line !== this.lastPaperLog) {
        this.lastPaperLog = line;
        log("paper-pnl", {
          usdc: report.usdc,
          value: report.value,
          pnl: report.pnl,
          start: report.start,
          fills: report.fills,
          positions: report.positions,
        });
      }
      this.health.update({
        lastCycleAt: new Date().toISOString(),
        markets: [...this.runtimes.values()].map((rt) => rt.health),
        paper: {
          usdc: report.usdc.toString(),
          value: report.value.toString(),
          pnl: report.pnl.toString(),
          start: report.start.toString(),
          fills: report.fills,
          positions: report.positions,
        },
      });
      return;
    }
    const mon = await this.client.getBalance({ address: this.maker });
    if (mon < LOW_MON) log("low-mon", { maker: this.maker, balance: formatEther(mon) }, "warn");
    this.health.update({
      lastCycleAt: new Date().toISOString(),
      monBalance: formatEther(mon),
      markets: [...this.runtimes.values()].map((rt) => rt.health),
    });
  }

  /** Logs a reason a market is not quoted once per market, not every cycle. */
  private skipOnce(market: MarketView, event: string, reason: string): void {
    const key = `${market.address}:${reason}`;
    if (this.skipped.has(key)) return;
    this.skipped.add(key);
    log(event, { market: market.address, template: market.templateId, reason });
  }

  private async handle(market: MarketView, now: ChainNow, wall: number): Promise<void> {
    if (market.phase === Phase.Settled || market.phase === Phase.Voided) {
      if (this.paper) {
        await this.paper.settle(market);
        return;
      }
      const rt = this.runtimes.get(market.address);
      if (rt && rt.tracker.orders().length > 0) await cancelMarket(this.deps, rt, PHASE_LABEL[market.phase]);
      await this.redeemLeftovers(market);
      return;
    }
    // Pools (even with a book prepared) have nothing to quote yet.
    if (market.phase !== Phase.Graduated && market.phase !== Phase.Closed) return;
    if (this.config.templates && !this.config.templates.includes(market.templateId)) {
      return this.skipOnce(market, "template-off", `template ${market.templateId} is not in MAKER_TEMPLATES`);
    }
    if (!PRICED_TEMPLATES.includes(market.templateId)) {
      return this.skipOnce(market, "no-model", `template ${market.templateId} has no pricing model`);
    }
    const rt = await this.runtimeFor(market);
    if (!rt) return;
    const block = BigInt(now.block);
    const closeIn = secondsToClose(market.window, now, this.blockSeconds);
    if (market.phase === Phase.Closed || closeIn <= this.config.closeBufferSeconds) {
      if (this.paper) await this.paper.stop(market, rt.info, block, "close");
      else if (!rt.unwound) await unwindMarket(this.deps, rt, { reason: "close", merge: true });
      rt.health.status = "closed";
      return;
    }

    let fair: FairResult;
    try {
      fair = await this.fair.forMarket(market.templateId, market.params, now);
    } catch (error) {
      if (!(error instanceof NoModelError)) throw error;
      return this.skipOnce(market, "no-model", error.message);
    }
    if (fair.decided) {
      // The answer is already fixed: resting quotes could only be picked off.
      if (this.paper) await this.paper.stop(market, rt.info, block, "answer-known");
      else if (!rt.unwound) await unwindMarket(this.deps, rt, { reason: "answer-known", merge: true });
      rt.health = { ...rt.health, status: "answer-known", fair: fair.p, detail: fair.detail };
      return;
    }
    rt.unwound = false;
    const widen = widenFactor(closeIn, this.config.widenSeconds, this.config.widenMax);
    const detail = { ...fair.detail, secondsToClose: Math.round(closeIn), template: market.templateId };
    if (this.paper) {
      await this.paper.quote(market, rt.info, { fair: fair.p, widen, block, now: wall, detail });
      rt.health = { ...rt.health, status: "paper", fair: fair.p, detail };
      return;
    }
    await quoteMarket(this.deps, rt, { fair: fair.p, widen, now: wall, detail });
  }

  /** After settlement, redeem the winning side; after a void, merge pairs and redeem the rest at 0.50. */
  private async redeemLeftovers(market: MarketView): Promise<void> {
    if (this.settledChecked.has(market.address)) return;
    const [yes, no] = await this.client.multicall({
      allowFailure: false,
      contracts: [
        { address: market.yes, abi: erc20Abi, functionName: "balanceOf", args: [this.maker] },
        { address: market.no, abi: erc20Abi, functionName: "balanceOf", args: [this.maker] },
      ],
    });
    const redeem = async (side: Side, amount: bigint) => {
      if (amount === 0n) return;
      await sendTx(this.tx, {
        to: market.vault,
        data: encodeFunctionData({
          abi: collateralVaultAbi,
          functionName: "redeem",
          args: [market.address, side, amount, this.maker],
        }),
        abi: collateralVaultAbi,
        action: "redeem",
        fields: { market: market.address, side: side === Side.Yes ? "yes" : "no", amount },
      });
    };
    if (market.phase === Phase.Settled) {
      if (market.outcome === Outcome.Yes) await redeem(Side.Yes, yes);
      if (market.outcome === Outcome.No) await redeem(Side.No, no);
    } else {
      await redeem(Side.Yes, yes);
      await redeem(Side.No, no);
    }
    if (this.config.enabled) this.settledChecked.add(market.address);
  }

  /** Cancels every order of ours on every known book and pulls margin balances back to the wallet. */
  async cancelEverything(reason: string, extraBooks: Address[] = []): Promise<void> {
    if (this.paper) {
      log("paper-stop-all", { reason, note: "paper mode has no orders on any book" });
      return;
    }
    const books = new Map<Address, true>();
    if (this.directory) {
      for (const market of await this.directory.refresh()) {
        if (market.book !== zeroAddress) books.set(market.book, true);
      }
    }
    for (const rt of this.runtimes.values()) books.set(rt.book, true);
    for (const book of extraBooks) books.set(book, true);
    for (const book of books.keys()) {
      try {
        await cancelBook(this.deps, book, await readBookInfo(this.client, book), reason);
      } catch (error) {
        log("cancel-error", { book, error: errorMessage(error) }, "error");
      }
    }
    for (const rt of this.runtimes.values()) {
      rt.synced = false;
      rt.health = { ...rt.health, status: reason, bids: [], asks: [], openOrders: 0 };
    }
    this.health.update({ markets: [...this.runtimes.values()].map((rt) => rt.health) });
  }
}
