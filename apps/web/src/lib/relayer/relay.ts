import { Phase } from "@hunch-book/shared";
import { type Address, type Hex, isAddressEqual, recoverTypedDataAddress, type TypedDataDomain } from "viem";
import { formatUsdc } from "../format";
import { networkAllowed, type RelayerConfig } from "./config";
import { MON_FAUCET_URL, type RelayerDeps, type RouteResult } from "./drip";
import { checkValidity, parseRelayStakeRequest, type RelayStakeRequest } from "./request";
import { DAY_SECONDS, utcDay } from "./store";
import { stakeAuthorizationNonce, stakeTypedData } from "./typedData";

// POST /api/relay/stake: submits Market.stakeWithAuthorization for a user who signed an EIP-3009
// ReceiveWithAuthorization, so a new account can stake with no MON at all. The relayer pays gas
// only. It can never change the market, the side, the amount or the recipient: the signature and
// the market's own nonce rule (PROTOCOL.md §7.2) bind all of them. Before spending gas it checks the
// market is a factory market in its pool phase, the nonce is the market's, the authorisation is
// unused and signed by the user, the user holds the USDC, and a simulation succeeds.

export interface MarketCheck {
  isMarket: boolean;
  phase: number;
  /** Market.authorizationNonce(user, side, salt), read from the market. */
  nonce: Hex;
  minStake: bigint;
}

export interface RelayChain {
  relayer: Address;
  chainId: number;
  checkMarket(r: RelayStakeRequest): Promise<MarketCheck>;
  /** USDC's EIP-712 domain, read from the token and checked against its DOMAIN_SEPARATOR. */
  usdcDomain(): Promise<TypedDataDomain>;
  tokenState(user: Address, nonce: Hex): Promise<{ used: boolean; balance: bigint }>;
  /** Simulates, then sends stakeWithAuthorization from the relayer. Throws a plain-word error. */
  submit(r: RelayStakeRequest): Promise<Hex>;
  txUrl(hash: Hex): string;
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): RouteResult => ({
  status,
  body: { ok: false, error, ...extra },
});

export function relayNotConfigured(): RouteResult {
  return fail(503, "Relayed stakes are not set up on this server. You need a little MON to stake.", {
    reason: "not-configured",
    faucet: MON_FAUCET_URL,
  });
}

/** GET /api/relay/stake: whether relaying runs here, and its limits. */
export function relayStatus(config: RelayerConfig, network: RelayStakeRequest["network"]): RouteResult {
  if (!config.privateKey) return { status: 200, body: { enabled: false, reason: "not-configured" } };
  const blocked = networkAllowed(config, network, "relay");
  if (blocked) return { status: 200, body: { enabled: false, reason: "network", message: blocked } };
  return {
    status: 200,
    body: {
      enabled: true,
      network,
      maxStake: config.relay.maxStake.toString(),
      maxValiditySeconds: config.relay.maxValiditySeconds,
    },
  };
}

export async function handleRelayStake(
  body: unknown,
  ip: string,
  deps: RelayerDeps<RelayChain>,
): Promise<RouteResult> {
  const { config, store } = deps;
  if (!config.privateKey) return relayNotConfigured();
  const parsed = parseRelayStakeRequest(body, deps.defaultNetwork);
  if (!parsed.ok) return fail(400, parsed.error);
  const r = parsed.value;
  const blocked = networkAllowed(config, r.network, "relay");
  if (blocked) return fail(403, blocked, { reason: "network" });

  const timing = checkValidity(r, deps.now() / 1000, { maxSeconds: config.relay.maxValiditySeconds });
  if (timing) return fail(400, timing);
  if (r.amount > config.relay.maxStake) {
    return fail(
      400,
      `The relayer submits stakes of up to ${formatUsdc(config.relay.maxStake)} USDC. Stake less, or stake from your own wallet.`,
    );
  }

  const day = utcDay(deps.now());
  const withinCaps =
    (await store.hit(`relay:ip:${day}:${ip}`, config.relay.perIpPerDay, 2 * DAY_SECONDS)) &&
    (await store.hit(
      `relay:user:${day}:${r.user.toLowerCase()}`,
      config.relay.perUserPerDay,
      2 * DAY_SECONDS,
    )) &&
    (await store.hit(`relay:day:${day}`, config.relay.perDay, 2 * DAY_SECONDS));
  if (!withinCaps) {
    return fail(
      429,
      "The relayer has reached today's limit for you. Stake from your own wallet with a little MON.",
      {
        reason: "cap",
        faucet: MON_FAUCET_URL,
      },
    );
  }

  const chain = deps.chain(r.network);
  const market = await chain.checkMarket(r);
  if (!market.isMarket) return fail(400, "That address is not a Hunch Book market.");
  if (market.phase !== Phase.Pool) return fail(409, "Staking in this market is closed.");
  if (r.amount < market.minStake) {
    return fail(400, `This market's minimum stake is ${formatUsdc(market.minStake)} USDC.`);
  }
  const nonce = stakeAuthorizationNonce({
    chainId: chain.chainId,
    market: r.market,
    user: r.user,
    side: r.side,
    salt: r.salt,
  });
  if (nonce.toLowerCase() !== market.nonce.toLowerCase()) {
    return fail(400, "The authorisation's nonce does not match the market's rule. Sign again.");
  }

  const domain = await chain.usdcDomain();
  const typed = stakeTypedData(domain, r);
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({ ...typed, signature: r.signature });
  } catch {
    return fail(400, "The signature could not be read. Sign again.");
  }
  if (!isAddressEqual(signer, r.user)) {
    return fail(400, "The signature is not from this account. Sign again from the account that stakes.");
  }

  const token = await chain.tokenState(r.user, nonce);
  if (token.used) return fail(409, "This authorisation was already used.");
  if (token.balance < r.amount) return fail(400, "Your account does not hold enough USDC for that stake.");

  try {
    const hash = await chain.submit(r);
    return { status: 200, body: { ok: true, hash, url: chain.txUrl(hash), network: r.network } };
  } catch (error) {
    return fail(
      422,
      error instanceof Error && error.message ? error.message : "The stake could not be sent.",
    );
  }
}
