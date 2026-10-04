import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { log, toJson } from "./log.js";

// The notifier's health: a JSON file after every cycle and, with NOTIFIER_HEALTH_PORT, GET /health.

export interface HealthSnapshot {
  updatedAt: string;
  network: string;
  /** "live" sends to Telegram; "dry-run" prints. */
  mode: "live" | "dry-run";
  source: "chain" | "indexer";
  cycles: number;
  lastCycleAt?: string;
  markets: number;
  chats: number;
  watchedWallets: number;
  messagesSent: number;
  lastMessageAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export class Health {
  private snapshot: HealthSnapshot;
  private server: Server | undefined;

  constructor(
    private readonly file: string | null,
    base: Pick<HealthSnapshot, "network" | "mode">,
  ) {
    this.snapshot = {
      ...base,
      updatedAt: new Date().toISOString(),
      source: "chain",
      cycles: 0,
      markets: 0,
      chats: 0,
      watchedWallets: 0,
      messagesSent: 0,
    };
  }

  current(): HealthSnapshot {
    return this.snapshot;
  }

  update(patch: Partial<HealthSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, updatedAt: new Date().toISOString() };
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, toJson(this.snapshot, 2));
      renameSync(tmp, this.file);
    } catch (error) {
      log("health-write-failed", { error: String(error) }, "warn");
    }
  }

  error(message: string): void {
    this.update({ lastError: message, lastErrorAt: new Date().toISOString() });
  }

  serve(port: number): void {
    this.server = createServer((req, res) => {
      if (req.url === "/health" || req.url === "/") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(toJson(this.snapshot, 2));
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
