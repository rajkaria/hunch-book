import { afterEach, describe, expect, it, vi } from "vitest";
import { rateLimitedFetch } from "../src/rpc.js";

describe("rateLimitedFetch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spaces requests to the rate limit, in order", async () => {
    vi.useFakeTimers({ now: 0 });
    const started: number[] = [];
    const fake = (async () => {
      started.push(Date.now());
      return new Response("{}");
    }) as typeof fetch;
    const limited = rateLimitedFetch(20, fake);
    const all = Promise.all(Array.from({ length: 6 }, () => limited("http://rpc")));
    await vi.advanceTimersByTimeAsync(1_000);
    await all;
    expect(started).toEqual([0, 50, 100, 150, 200, 250]);
  });

  it("does not delay requests that are already spaced out", async () => {
    vi.useFakeTimers({ now: 0 });
    const started: number[] = [];
    const limited = rateLimitedFetch(10, (async () => {
      started.push(Date.now());
      return new Response("{}");
    }) as typeof fetch);
    await limited("http://rpc");
    await vi.advanceTimersByTimeAsync(500);
    await limited("http://rpc");
    expect(started).toEqual([0, 500]);
  });
});
