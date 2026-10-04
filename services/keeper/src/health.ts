import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { log, toJson } from "./log.js";
import type { JobName } from "./plan.js";

// The keeper's health: written to a JSON file after every cycle and, when KEEPER_HEALTH_PORT is set,
// served at GET /health. Per job: when it last ran, its last action (with the transaction link) and
// its last error. Overall: markets per phase, the keeper's MON balance and the last error.

export type HealthJob = JobName | "discover";

export interface LastAction {
  at: string;
  market: string;
  action: string;
  /** success, reverted, unknown, skipped, dry-run, or requested (a book request). */
  status: string;
  hash?: string;
  url?: string;
}

export interface JobHealth {
  lastRunAt?: string;
  lastActionAt?: string;
  lastAction?: LastAction;
  /** Markets where this job had something to send in the last cycle. */
  due: number;
  lastError?: string;
  lastErrorAt?: string;
}

export interface HealthSnapshot {
  updatedAt: string;
  status: "ok" | "warn";
  network: string;
  keeper: string;
  enabled: boolean;
  cycles: number;
  lastCycleAt?: string;
  lastCycleMs?: number;
  block?: string;
  monBalance?: string;
  minMon: number;
  lowBalance: boolean;
  markets: { total: number; done: number; byPhase: Record<string, number> };
  jobs: Record<HealthJob, JobHealth>;
  scan: { factoryCursor?: number; requestsLastCycle: number };
  lastError?: string;
  lastErrorAt?: string;
}

export const JOBS: HealthJob[] = ["discover", "graduate", "claims", "settle", "void", "payouts"];

export class Health {
  private snapshot: HealthSnapshot;
  private server: Server | undefined;

  constructor(
    private readonly file: string,
    base: { network: string; keeper: string; enabled: boolean; minMon: number },
  ) {
    this.snapshot = {
      ...base,
      updatedAt: new Date().toISOString(),
      status: "ok",
      cycles: 0,
      lowBalance: false,
      markets: { total: 0, done: 0, byPhase: {} },
      jobs: Object.fromEntries(JOBS.map((j) => [j, { due: 0 }])) as Record<HealthJob, JobHealth>,
      scan: { requestsLastCycle: 0 },
    };
  }

  current(): HealthSnapshot {
    return this.snapshot;
  }

  jobRan(job: HealthJob, at: string): void {
    this.snapshot.jobs[job].lastRunAt = at;
  }

  setDue(due: Partial<Record<HealthJob, number>>): void {
    for (const job of JOBS) this.snapshot.jobs[job].due = due[job] ?? 0;
  }

  jobAction(job: HealthJob, action: Omit<LastAction, "at">): void {
    const at = new Date().toISOString();
    this.snapshot.jobs[job].lastActionAt = at;
    this.snapshot.jobs[job].lastAction = { at, ...action };
  }

  jobError(job: HealthJob, message: string): void {
    const at = new Date().toISOString();
    this.snapshot.jobs[job].lastError = message;
    this.snapshot.jobs[job].lastErrorAt = at;
    this.snapshot.lastError = message;
    this.snapshot.lastErrorAt = at;
  }

  update(patch: Partial<HealthSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, updatedAt: new Date().toISOString() };
    this.snapshot.status = this.snapshot.lowBalance ? "warn" : "ok";
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, toJson(this.snapshot, 2));
      renameSync(tmp, this.file);
    } catch (error) {
      log("health-write-failed", { file: this.file, error: String(error) }, "warn");
    }
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
