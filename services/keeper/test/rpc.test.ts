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
    const limited = rateLimitedFetch(10, fake);
    const all = Promise.all(Array.from({ length: 5 }, () => limited("http://rpc")));
    await vi.advanceTimersByTimeAsync(1_000);
    await all;
    expect(started).toEqual([0, 100, 200, 300, 400]);
  });
});
