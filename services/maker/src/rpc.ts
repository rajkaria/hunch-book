// Public Monad RPCs cap request rates (testnet answers "requests limited to 15/sec"). The bot spaces its
// own requests so a burst of reads never trips the limit.

type Fetch = typeof fetch;

/** A fetch that starts at most `perSecond` requests per second, in order, delaying the rest. */
export function rateLimitedFetch(perSecond: number, inner: Fetch = fetch): Fetch {
  const gap = 1000 / perSecond;
  let next = 0;
  return async (input, init) => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
    return inner(input, init);
  };
}
