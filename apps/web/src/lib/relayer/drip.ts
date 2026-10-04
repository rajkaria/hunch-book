import type { Network } from "@hunch-book/shared";
import { type Address, formatEther, type Hex, isAddressEqual } from "viem";
import { networkAllowed, type RelayerConfig } from "./config";
import { parseDripRequest } from "./request";
import { DAY_SECONDS, type RelayStore, utcDay } from "./store";

// POST /api/drip: a small amount of MON for a brand-new account, so its first transactions have gas
// (PROTOCOL.md §9.5). Every check that can be read from the chain is read from the chain: the address
// must hold less than the threshold and must never have sent a transaction (nonce 0). Once it has
// MON it cannot fall below the threshold again without sending a transaction, so the chain itself
// stops a second drip. The store adds a once-per-address claim and the per-IP and daily caps.

/** Gas the relayer keeps back beyond the drip itself. */
export const RELAYER_GAS_RESERVE_WEI = 10n ** 16n; // 0.01 MON

export interface DripChain {
  relayer: Address;
  getBalance(address: Address): Promise<bigint>;
  getTransactionCount(address: Address): Promise<number>;
  getCode(address: Address): Promise<Hex | undefined>;
  /** Sends `value` wei to `to` from the relayer and returns the hash. Serialised by the caller. */
  sendValue(to: Address, value: bigint): Promise<Hex>;
  txUrl(hash: Hex): string;
}

export interface RelayerDeps<C> {
  config: RelayerConfig;
  store: RelayStore;
  chain(network: Network): C;
  now(): number;
  /** The network a request names when it names none: the app's own. */
  defaultNetwork: Network;
}

export interface RouteResult {
  status: number;
  body: Record<string, unknown>;
}

export const MON_FAUCET_URL = "https://faucet.monad.xyz";

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): RouteResult => ({
  status,
  body: { ok: false, error, ...extra },
});

export function dripNotConfigured(): RouteResult {
  return fail(503, "The gas drip is not set up on this server. You need a little MON in your account.", {
    reason: "not-configured",
    faucet: MON_FAUCET_URL,
  });
}

/** GET /api/drip: whether the drip runs here, and its terms. */
export function dripStatus(config: RelayerConfig, network: Network): RouteResult {
  if (!config.privateKey) return { status: 200, body: { enabled: false, reason: "not-configured" } };
  const blocked = networkAllowed(config, network, "drip");
  if (blocked) return { status: 200, body: { enabled: false, reason: "network", message: blocked } };
  return {
    status: 200,
    body: {
      enabled: true,
      network,
      amountMon: formatEther(config.drip.amountWei),
      belowMon: formatEther(config.drip.belowWei),
      perIpPerDay: config.drip.perIpPerDay,
    },
  };
}

export async function handleDrip(
  body: unknown,
  ip: string,
  deps: RelayerDeps<DripChain>,
): Promise<RouteResult> {
  const { config, store } = deps;
  if (!config.privateKey) return dripNotConfigured();
  const parsed = parseDripRequest(body, deps.defaultNetwork);
  if (!parsed.ok) return fail(400, parsed.error);
  const { address, network } = parsed.value;
  const blocked = networkAllowed(config, network, "drip");
  if (blocked) return fail(403, blocked, { reason: "network" });

  const chain = deps.chain(network);
  if (isAddressEqual(address, chain.relayer)) return fail(400, "That is the relayer's own address.");

  const [code, balance, nonce] = await Promise.all([
    chain.getCode(address),
    chain.getBalance(address),
    chain.getTransactionCount(address),
  ]);
  if (code && code !== "0x") return fail(400, "The drip is for accounts, not contracts.");
  if (balance >= config.drip.belowWei) {
    return fail(409, "This account already has MON for gas.", { reason: "has-gas" });
  }
  if (nonce > 0) {
    return fail(
      409,
      "The drip is for new accounts only, and this one has sent transactions before. Get MON from the faucet.",
      { reason: "not-new", faucet: MON_FAUCET_URL },
    );
  }

  const day = utcDay(deps.now());
  const onceKey = `drip:${network}:${address.toLowerCase()}`;
  if (!(await store.claimOnce(onceKey, 365 * DAY_SECONDS))) {
    return fail(409, "This account already got its gas drip.", { reason: "already-dripped" });
  }
  const capped =
    !(await store.hit(`drip:ip:${day}:${ip}`, config.drip.perIpPerDay, 2 * DAY_SECONDS)) ||
    !(await store.hit(`drip:day:${day}`, config.drip.perDay, 2 * DAY_SECONDS));
  if (capped) {
    await store.release(onceKey);
    return fail(429, "The gas drip has reached today's limit. Try again tomorrow, or use the faucet.", {
      reason: "cap",
      faucet: MON_FAUCET_URL,
    });
  }

  const reserve = await chain.getBalance(chain.relayer);
  if (reserve < config.drip.amountWei + RELAYER_GAS_RESERVE_WEI) {
    await store.release(onceKey);
    return fail(503, "The gas drip is empty right now. Use the faucet, or try later.", {
      reason: "empty",
      faucet: MON_FAUCET_URL,
    });
  }

  try {
    const hash = await chain.sendValue(address, config.drip.amountWei);
    return {
      status: 200,
      body: {
        ok: true,
        hash,
        url: chain.txUrl(hash),
        amountMon: formatEther(config.drip.amountWei),
        network,
      },
    };
  } catch {
    await store.release(onceKey);
    return fail(502, "The drip transaction could not be sent. Try again in a minute.");
  }
}
