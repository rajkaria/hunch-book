import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Alerter } from "../src/alerts.js";
import { Health } from "../src/health.js";
import { log, redact, setLogSink, setRedactions } from "../src/log.js";

const BASE = { service: "hunch-book-keeper", network: "monad-testnet", keeper: "0xabc", enabled: true };

function recorder(status = 200) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response("ok", { status });
  }) as typeof fetch;
  return { posts, fetchFn };
}

afterEach(() => {
  setRedactions([]);
  setLogSink((line) => console.log(line));
});

describe("Alerter", () => {
  it("posts JSON once per key per repeat window", async () => {
    let now = 1_000_000;
    const { posts, fetchFn } = recorder();
    const alerter = new Alerter("https://hooks.example.com/x", BASE, 60, fetchFn, () => now);
    expect(await alerter.send("low-mon", "low-mon", { balance: "0.1" }, "warn")).toBe(true);
    expect(await alerter.send("low-mon", "low-mon", { balance: "0.1" }, "warn")).toBe(false);
    expect(await alerter.send("error:settle:0x1", "job-error", { error: "x" })).toBe(true);
    now += 60_000;
    expect(await alerter.send("low-mon", "low-mon", { balance: "0.09" }, "warn")).toBe(true);
    expect(posts).toHaveLength(3);
    expect(posts[0]).toEqual({
      url: "https://hooks.example.com/x",
      body: {
        ...BASE,
        level: "warn",
        event: "low-mon",
        ts: new Date(1_000_000).toISOString(),
        balance: "0.1",
      },
    });
  });

  it("does nothing without a webhook, and never throws when the webhook fails", async () => {
    expect(await new Alerter(undefined, BASE, 0).send("k", "e", {})).toBe(false);
    const lines: Record<string, unknown>[] = [];
    setLogSink((line) => lines.push(JSON.parse(line)));
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await new Alerter("https://x.example.com", BASE, 0, failing).send("k", "e", {})).toBe(false);
    expect(
      await new Alerter("https://x.example.com", BASE, 0, recorder(500).fetchFn).send("k2", "e", {}),
    ).toBe(false);
    expect(lines.map((l) => l.event)).toEqual(["alert-failed", "alert-failed"]);
  });

  it("cuts secrets out of alerts and log lines", async () => {
    setRedactions(["sk-secret-123456", "https://rpc.example.com/key-abcdef"]);
    const { posts, fetchFn } = recorder();
    await new Alerter("https://x.example.com", BASE, 0, fetchFn).send("k", "job-error", {
      error: "HTTP request failed. URL: https://rpc.example.com/key-abcdef with sk-secret-123456",
    });
    expect(JSON.stringify(posts[0]?.body)).not.toMatch(/secret|key-abcdef/);
    expect(posts[0]?.body.error).toBe("HTTP request failed. URL: [redacted] with [redacted]");

    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    log("x", { note: "sk-secret-123456" });
    expect(lines[0]).toContain("[redacted]");
    expect(redact("short")).toBe("short");
  });

  it("never lets a field overwrite a log line's event or level", () => {
    const lines: Record<string, unknown>[] = [];
    setLogSink((line) => lines.push(JSON.parse(line)));
    log("real", { event: "fake", level: "error", note: 1 });
    expect(lines[0]).toMatchObject({ event: "real", level: "info", note: 1 });
  });
});

describe("Health", () => {
  it("writes the snapshot with per-job actions and a warning status on low balance", () => {
    const file = join(mkdtempSync(join(tmpdir(), "keeper-health-")), "health.json");
    const health = new Health(file, {
      network: "monad-testnet",
      keeper: "0xabc",
      enabled: false,
      minMon: 0.5,
    });
    health.jobRan("settle", "2026-10-04T00:00:00.000Z");
    health.jobAction("settle", { market: "0xm", action: "settle", status: "success", hash: "0xh", url: "u" });
    health.jobError("claims", "boom");
    health.setDue({ settle: 2 });
    health.update({ monBalance: "0.1", lowBalance: true });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.status).toBe("warn");
    expect(saved.jobs.settle).toMatchObject({
      due: 2,
      lastRunAt: "2026-10-04T00:00:00.000Z",
      lastAction: { market: "0xm", action: "settle", status: "success", hash: "0xh", url: "u" },
    });
    expect(saved.jobs.claims).toMatchObject({ due: 0, lastError: "boom" });
    expect(saved.lastError).toBe("boom");
    expect(Object.keys(saved.jobs)).toEqual(["discover", "graduate", "claims", "settle", "void", "payouts"]);
  });
});
