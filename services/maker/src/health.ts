import { renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { log } from "./log.js";
import type { MarketHealth } from "./maker.js";

// The bot's health: written to a JSON file after every cycle and, when MAKER_HEALTH_PORT is set,
// served at GET /health. It reports when the bot last quoted, its open orders, its inventory per market
// and its MON balance.

export interface HealthSnapshot {
  updatedAt: string;
  network: string;
  /** The stack this bot quotes on ("primary" or a name under `stacks`) and its Kuru version. */
  stack?: string;
  kuruVersion?: number;
  maker: string;
  enabled: boolean;
  monBalance?: string;
  lastCycleAt?: string;
  lastQuoteAt?: string;
  openOrders: number;
  lastError?: string;
  markets: MarketHealth[];
  /** "live" or "paper" (MAKER_MODE). */
  mode: string;
  /** Paper mode: the simulated account, in USDC base units. */
  paper?: {
    usdc: string;
    value: string;
    pnl: string;
    start: string;
    fills: number;
    positions: Record<string, { yes: string; no: string; mark: number; fills: number; volume: string }>;
  };
}

const json = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

export class Health {
  private snapshot: HealthSnapshot;
  private server: Server | undefined;

  constructor(
    private readonly file: string,
    base: {
      network: string;
      maker: string;
      enabled: boolean;
      mode: string;
      stack?: string;
      kuruVersion?: number;
    },
  ) {
    this.snapshot = { ...base, updatedAt: new Date().toISOString(), openOrders: 0, markets: [] };
  }

  update(patch: Partial<HealthSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, updatedAt: new Date().toISOString() };
    const markets = this.snapshot.markets;
    this.snapshot.openOrders = markets.reduce((sum, m) => sum + m.openOrders, 0);
    const quoted = markets.map((m) => m.lastQuoteAt).filter((t): t is string => Boolean(t));
    if (quoted.length > 0) this.snapshot.lastQuoteAt = quoted.sort().at(-1);
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, json(this.snapshot));
      renameSync(tmp, this.file);
    } catch (error) {
      log("health-write-failed", { file: this.file, error: String(error) }, "warn");
    }
  }

  current(): HealthSnapshot {
    return this.snapshot;
  }

  /** GET /health: this snapshot. GET /health/<name>: the snapshot of another stack's bot. */
  serve(port: number, others: Record<string, Health> = {}): void {
    this.server = createServer((req, res) => {
      const other = req.url?.startsWith("/health/") ? others[req.url.slice("/health/".length)] : undefined;
      if (req.url === "/health" || req.url === "/" || other) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(json(other ? other.current() : this.snapshot));
      } else {
        res.writeHead(404).end();
      }
    });
    this.server.listen(port, () => log("health-endpoint", { url: `http://localhost:${port}/health` }));
  }

  close(): void {
    this.server?.close();
  }
}
