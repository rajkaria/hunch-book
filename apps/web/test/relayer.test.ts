import { Phase } from "@hunch-book/shared";
import {
  type Address,
  concat,
  encodeAbiParameters,
  getAddress,
  type Hex,
  hashTypedData,
  keccak256,
  pad,
  parseEther,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { prepareRelayedStake, requestDrip, submitRelayedStake } from "../src/lib/relayer/client";
import { networkAllowed, parseRelayerConfig } from "../src/lib/relayer/config";
import { type DripChain, handleDrip, type RelayerDeps } from "../src/lib/relayer/drip";
import { readJson, safeErrorText } from "../src/lib/relayer/http";
import { handleRelayStake, type MarketCheck, type RelayChain } from "../src/lib/relayer/relay";
import { checkValidity, parseDripRequest, parseRelayStakeRequest } from "../src/lib/relayer/request";
import { KvStore, MemoryStore } from "../src/lib/relayer/store";
import {
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  readUsdcDomain,
  stakeAuthorizationNonce,
  stakeTypedData,
} from "../src/lib/relayer/typedData";

const KEY = `0x${"11".repeat(32)}` as Hex;
const MARKET = "0x00000000000000000000000000000000000000a1" as Address;
const USDC_TOKEN = "0x13c5B2e982F437566991c4d9aC0a30F9f9aC15Ed" as Address;
const SALT = `0x${"ab".repeat(32)}` as Hex;
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

const DOMAIN = { name: "Hunch Book Test USDC", version: "1", chainId: 10143, verifyingContract: USDC_TOKEN };

// ---------------------------------------------------------------- typed data

describe("stake authorisation typed data", () => {
  it("binds the nonce exactly like Market.authorizationNonce (abi.encode of five words)", () => {
    const user = "0x00000000000000000000000000000000000000b0" as Address;
    const manual = keccak256(concat([pad(toHex(10143)), pad(MARKET), pad(user), pad(toHex(1)), SALT]));
    expect(stakeAuthorizationNonce({ chainId: 10143, market: MARKET, user, side: 1, salt: SALT })).toBe(
      manual,
    );
    // A different side, market or chain gives a different nonce: the signature cannot be moved.
    const yes = stakeAuthorizationNonce({ chainId: 10143, market: MARKET, user, side: 0, salt: SALT });
    expect(yes).not.toBe(manual);
    expect(stakeAuthorizationNonce({ chainId: 143, market: MARKET, user, side: 1, salt: SALT })).not.toBe(
      manual,
    );
  });

  it("hashes to the digest TestUSDC (and Circle's FiatToken) verifies", () => {
    const user = privateKeyToAccount(KEY).address;
    const auth = {
      market: MARKET,
      user,
      side: 0 as const,
      amount: 25_000_000n,
      validAfter: 1n,
      validBefore: 2n,
      salt: SALT,
    };
    const typed = stakeTypedData(DOMAIN, auth);
    const domainTypehash = keccak256(
      toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    );
    const separator = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "address" },
        ],
        [domainTypehash, keccak256(toHex(DOMAIN.name)), keccak256(toHex("1")), 10143n, USDC_TOKEN],
      ),
    );
    const receiveTypehash = keccak256(
      toHex(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
        ],
        [receiveTypehash, user, MARKET, 25_000_000n, 1n, 2n, typed.message.nonce],
      ),
    );
    const digest = keccak256(concat(["0x1901", separator, structHash]));
    expect(hashTypedData(typed)).toBe(digest);
    expect(typed.message.to).toBe(MARKET);
    expect(typed.types).toBe(RECEIVE_WITH_AUTHORIZATION_TYPES);
  });

  it("reads the domain from the token and checks it against DOMAIN_SEPARATOR", async () => {
    const separator = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "address" },
        ],
        [
          keccak256(
            toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
          ),
          keccak256(toHex(DOMAIN.name)),
          keccak256(toHex("1")),
          10143n,
          USDC_TOKEN,
        ],
      ),
    );
    const fallbackClient = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "DOMAIN_SEPARATOR") return separator;
        if (functionName === "eip712Domain") throw new Error("no EIP-5267");
        if (functionName === "name") return DOMAIN.name;
        if (functionName === "version") return "1";
        throw new Error(functionName);
      }),
    };
    expect(await readUsdcDomain(fallbackClient as never, USDC_TOKEN, 10143)).toEqual(DOMAIN);

    const eip5267 = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "DOMAIN_SEPARATOR") return separator;
        if (functionName === "eip712Domain") return ["0x0f", DOMAIN.name, "1", 10143n, USDC_TOKEN, SALT, []];
        throw new Error(functionName);
      }),
    };
    expect(await readUsdcDomain(eip5267 as never, USDC_TOKEN, 10143)).toEqual(DOMAIN);

    const wrongVersion = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "DOMAIN_SEPARATOR") return separator;
        if (functionName === "eip712Domain") throw new Error("no EIP-5267");
        return functionName === "name" ? DOMAIN.name : "2";
      }),
    };
    await expect(readUsdcDomain(wrongVersion as never, USDC_TOKEN, 10143)).rejects.toThrow(
      /DOMAIN_SEPARATOR/,
    );
    await expect(readUsdcDomain(eip5267 as never, USDC_TOKEN, 143)).rejects.toThrow(/another chain/);
  });

  it("builds a signable request that the relay route accepts as it is", async () => {
    const account = privateKeyToAccount(KEY);
    const { auth, typedData } = await prepareRelayedStake({
      client: { readContract: vi.fn() } as never,
      chainId: 10143,
      usdc: USDC_TOKEN,
      market: MARKET,
      user: account.address,
      side: 1,
      amount: 10_000_000n,
      nowSeconds: NOW,
      domain: DOMAIN,
    });
    expect(auth.validAfter).toBe(BigInt(NOW - 60));
    expect(auth.validBefore).toBe(BigInt(NOW + 600));
    expect(auth.salt).toMatch(/^0x[0-9a-f]{64}$/);
    const signature = await account.signTypedData(typedData);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const parsed = parseRelayStakeRequest(body, "monad-testnet");
      expect(parsed.ok).toBe(true);
      return new Response(JSON.stringify({ ok: true, hash: `0x${"cd".repeat(32)}`, url: "https://x/tx" }));
    });
    const result = await submitRelayedStake(auth, signature, "monad-testnet", fetchImpl);
    expect(result).toMatchObject({ ok: true, hash: `0x${"cd".repeat(32)}` });
  });
});

// ---------------------------------------------------------------- request parsing

describe("request parsing", () => {
  const good = {
    market: MARKET,
    user: "0x00000000000000000000000000000000000000b0",
    side: "yes",
    amount: "5000000",
    validAfter: String(NOW - 60),
    validBefore: String(NOW + 600),
    salt: SALT,
    signature: `0x${"22".repeat(65)}`,
  };

  it("accepts a well-formed relay request and defaults the network", () => {
    const r = parseRelayStakeRequest(good, "monad-testnet");
    expect(r.ok && r.value).toMatchObject({ side: 0, amount: 5_000_000n, network: "monad-testnet" });
  });

  it.each([
    [{ ...good, market: "0x123" }, /market is not an address/],
    [{ ...good, user: "0x0000000000000000000000000000000000000000" }, /zero address/],
    [{ ...good, side: 2 }, /side must be/],
    [{ ...good, amount: "-1" }, /whole number/],
    [{ ...good, amount: "0" }, /above zero/],
    [{ ...good, amount: 1.5 }, /whole number/],
    [{ ...good, salt: "0x1234" }, /32 bytes/],
    [{ ...good, signature: `0x${"22".repeat(64)}` }, /65 bytes/],
    [{ ...good, network: "ethereum" }, /Unknown network/],
    [[1, 2], /JSON object/],
    [null, /JSON object/],
  ])("refuses %#", (body, message) => {
    const r = parseRelayStakeRequest(body, "monad-testnet");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it("parses drip requests", () => {
    expect(parseDripRequest({ address: good.user }, "monad-testnet").ok).toBe(true);
    expect(parseDripRequest({ address: "nope" }, "monad-testnet").ok).toBe(false);
    expect(parseDripRequest("x", "monad-testnet").ok).toBe(false);
  });

  it("checks the authorisation's time window like the token, plus the relayer's limits", () => {
    expect(checkValidity({ validAfter: BigInt(NOW - 1), validBefore: BigInt(NOW + 600) }, NOW)).toBeNull();
    expect(checkValidity({ validAfter: BigInt(NOW), validBefore: BigInt(NOW + 600) }, NOW)).toMatch(
      /not valid yet/,
    );
    expect(checkValidity({ validAfter: 0n, validBefore: BigInt(NOW + 10) }, NOW)).toMatch(/too soon/);
    expect(checkValidity({ validAfter: 0n, validBefore: BigInt(NOW + 7_200) }, NOW)).toMatch(
      /within 60 minutes/,
    );
  });

  it("reads JSON bodies safely", async () => {
    expect(await readJson(new Request("http://x", { method: "POST", body: '{"a":1}' }))).toEqual({ a: 1 });
    expect(await readJson(new Request("http://x", { method: "POST", body: "{" }))).toBeUndefined();
    expect(
      await readJson(new Request("http://x", { method: "POST", body: "x".repeat(5_000) })),
    ).toBeUndefined();
  });

  it("never lets a URL (which can carry an RPC key) into a log line", () => {
    expect(safeErrorText(new Error("failed at https://rpc.example/v1/SECRET123 boom"))).toBe(
      "failed at [url] boom",
    );
  });
});

// ---------------------------------------------------------------- config

describe("relayer config", () => {
  it("has safe defaults and no key", () => {
    const c = parseRelayerConfig({});
    expect(c.privateKey).toBeUndefined();
    expect(c.drip.amountWei).toBe(parseEther("0.05"));
    expect(c.drip.belowWei).toBe(parseEther("0.01"));
    expect(c.drip.mainnet).toBe(false);
    expect(c.relay.maxStake).toBe(1_000_000_000n);
    expect(c.relay.mainnet).toBe(false);
    expect(c.kv).toBeUndefined();
    expect(c.rpc["monad-testnet"]).toBe("https://testnet-rpc.monad.xyz");
  });

  it("reads every setting", () => {
    const c = parseRelayerConfig(
      {
        RELAYER_PRIVATE_KEY: KEY.slice(2),
        DRIP_AMOUNT_MON: "0.1",
        DRIP_BELOW_MON: "0.02",
        DRIP_IP_DAILY_CAP: "1",
        DRIP_DAILY_CAP: "5",
        DRIP_MAINNET: "1",
        RELAY_MAX_STAKE_USDC: "250.5",
        RELAY_IP_DAILY_CAP: "2",
        RELAY_USER_DAILY_CAP: "3",
        RELAY_DAILY_CAP: "4",
        RELAY_MAX_VALIDITY_SECONDS: "900",
        RELAY_MAINNET: "true",
        RELAYER_RPC_URL: "https://my-rpc.example",
        KV_REST_API_URL: "https://kv.example/",
        KV_REST_API_TOKEN: "token-token",
      },
      "monad-testnet",
    );
    expect(c.privateKey).toBe(KEY);
    expect(c.drip).toMatchObject({ amountWei: parseEther("0.1"), perIpPerDay: 1, perDay: 5, mainnet: true });
    expect(c.relay).toMatchObject({ maxStake: 250_500_000n, perIpPerDay: 2, perUserPerDay: 3, perDay: 4 });
    expect(c.relay.maxValiditySeconds).toBe(900);
    expect(c.rpc["monad-testnet"]).toBe("https://my-rpc.example");
    expect(c.kv).toEqual({ url: "https://kv.example", token: "token-token" });
  });

  it.each([
    [{ RELAYER_PRIVATE_KEY: "0x1234" }, /RELAYER_PRIVATE_KEY/],
    [{ DRIP_AMOUNT_MON: "lots" }, /DRIP_AMOUNT_MON/],
    [{ DRIP_DAILY_CAP: "-1" }, /DRIP_DAILY_CAP/],
    [{ RELAY_MAX_STAKE_USDC: "1.1234567" }, /RELAY_MAX_STAKE_USDC/],
  ])("refuses bad settings without echoing values %#", (env, message) => {
    expect(() => parseRelayerConfig(env)).toThrow(message);
  });

  it("keeps mainnet off unless asked", () => {
    const c = parseRelayerConfig({ RELAYER_PRIVATE_KEY: KEY });
    expect(networkAllowed(c, "monad-testnet", "drip")).toBeNull();
    expect(networkAllowed(c, "monad-mainnet", "drip")).toMatch(/testnet only/);
    expect(networkAllowed(c, "monad-mainnet", "relay")).toMatch(/testnet only/);
  });
});

// ---------------------------------------------------------------- stores

describe("rate stores", () => {
  it("memory: counts within a window and claims once until expiry", async () => {
    let now = 0;
    const store = new MemoryStore(() => now);
    expect(await store.hit("k", 2, 10)).toBe(true);
    expect(await store.hit("k", 2, 10)).toBe(true);
    expect(await store.hit("k", 2, 10)).toBe(false);
    now = 11_000;
    expect(await store.hit("k", 2, 10)).toBe(true);
    expect(await store.claimOnce("c", 5)).toBe(true);
    expect(await store.claimOnce("c", 5)).toBe(false);
    await store.release("c");
    expect(await store.claimOnce("c", 5)).toBe(true);
    now += 6_000;
    expect(await store.claimOnce("c", 5)).toBe(true);
  });

  it("KV: speaks Upstash's REST pipeline and fails closed", async () => {
    const calls: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const commands = JSON.parse(String(init.body)) as unknown[][];
      calls.push(commands);
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
      const first = commands[0]?.[0];
      if (first === "INCR") return new Response(JSON.stringify([{ result: 3 }, { result: 1 }]));
      if (first === "SET") return new Response(JSON.stringify([{ result: null }]));
      return new Response(JSON.stringify([{ result: 1 }]));
    });
    const store = new KvStore("https://kv.example", "tok", "p:", fetchImpl);
    expect(await store.hit("ip", 2, 60)).toBe(false);
    expect(await store.claimOnce("once", 60)).toBe(false);
    await store.release("once");
    expect(calls).toEqual([
      [
        ["INCR", "p:ip"],
        ["EXPIRE", "p:ip", 60],
      ],
      [["SET", "p:once", "1", "NX", "EX", 60]],
      [["DEL", "p:once"]],
    ]);
    const down = new KvStore(
      "https://kv.example",
      "tok",
      "p:",
      async () => new Response("no", { status: 500 }),
    );
    await expect(down.hit("ip", 2, 60)).rejects.toThrow(/500/);
  });
});

// ---------------------------------------------------------------- drip

const USER = "0x00000000000000000000000000000000000000b0" as Address;
const RELAYER = privateKeyToAccount(KEY).address;

function dripChain(overrides: Partial<DripChain> = {}): DripChain {
  return {
    relayer: RELAYER,
    getBalance: vi.fn(async (a: Address) => (a === RELAYER ? parseEther("10") : 0n)),
    getTransactionCount: vi.fn(async () => 0),
    getCode: vi.fn(async () => undefined),
    sendValue: vi.fn(async () => `0x${"ee".repeat(32)}` as Hex),
    txUrl: (hash) => `https://testnet.monadscan.com/tx/${hash}`,
    ...overrides,
  };
}

function deps<C>(
  chain: C,
  env: Record<string, string> = {},
  store = new MemoryStore(() => NOW_MS),
): RelayerDeps<C> {
  return {
    config: parseRelayerConfig({ RELAYER_PRIVATE_KEY: KEY, ...env }),
    store,
    chain: () => chain,
    now: () => NOW_MS,
    defaultNetwork: "monad-testnet",
  };
}

describe("POST /api/drip", () => {
  it("answers 503 with the faucet when no relayer key is set", async () => {
    const d = { ...deps(dripChain()), config: parseRelayerConfig({}) };
    const r = await handleDrip({ address: USER }, "1.1.1.1", d);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ reason: "not-configured", faucet: "https://faucet.monad.xyz" });
  });

  it("sends the drip once to a new, empty account", async () => {
    const chain = dripChain();
    const d = deps(chain);
    const r = await handleDrip({ address: USER }, "1.1.1.1", d);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, amountMon: "0.05" });
    expect(chain.sendValue).toHaveBeenCalledWith(getAddress(USER), parseEther("0.05"));
    const again = await handleDrip({ address: USER }, "2.2.2.2", d);
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe("already-dripped");
  });

  it("reads eligibility from the chain: balance, nonce, and no contracts", async () => {
    const funded = await handleDrip(
      { address: USER },
      "ip",
      deps(dripChain({ getBalance: vi.fn(async () => parseEther("0.5")) })),
    );
    expect(funded.status).toBe(409);
    expect(funded.body.reason).toBe("has-gas");
    const used = await handleDrip(
      { address: USER },
      "ip",
      deps(dripChain({ getTransactionCount: vi.fn(async () => 3) })),
    );
    expect(used.status).toBe(409);
    expect(used.body.reason).toBe("not-new");
    const contract = await handleDrip(
      { address: USER },
      "ip",
      deps(dripChain({ getCode: vi.fn(async () => "0x6080" as Hex) })),
    );
    expect(contract.status).toBe(400);
    const self = await handleDrip({ address: RELAYER }, "ip", deps(dripChain()));
    expect(self.status).toBe(400);
  });

  it("caps per IP and per day, and gives the address's claim back when capped", async () => {
    const store = new MemoryStore(() => NOW_MS);
    const chain = dripChain();
    const d = deps(chain, { DRIP_IP_DAILY_CAP: "1" }, store);
    const users = [
      "0x00000000000000000000000000000000000000c1",
      "0x00000000000000000000000000000000000000c2",
    ];
    expect((await handleDrip({ address: users[0] }, "9.9.9.9", d)).status).toBe(200);
    const capped = await handleDrip({ address: users[1] }, "9.9.9.9", d);
    expect(capped.status).toBe(429);
    // Another IP can still drip to the second address: its claim was released.
    expect((await handleDrip({ address: users[1] }, "8.8.8.8", d)).status).toBe(200);
    const global = deps(dripChain(), { DRIP_DAILY_CAP: "0" });
    expect((await handleDrip({ address: USER }, "7.7.7.7", global)).status).toBe(429);
  });

  it("refuses mainnet unless DRIP_MAINNET=1", async () => {
    const r = await handleDrip({ address: USER, network: "monad-mainnet" }, "ip", deps(dripChain()));
    expect(r.status).toBe(403);
    const allowed = await handleDrip(
      { address: USER, network: "monad-mainnet" },
      "ip",
      deps(dripChain(), { DRIP_MAINNET: "1" }),
    );
    expect(allowed.status).toBe(200);
  });

  it("says when the drip is empty, and releases the claim when sending fails", async () => {
    const empty = await handleDrip(
      { address: USER },
      "ip",
      deps(dripChain({ getBalance: vi.fn(async () => 0n) })),
    );
    expect(empty.status).toBe(503);
    expect(empty.body.reason).toBe("empty");
    const store = new MemoryStore(() => NOW_MS);
    const failing = dripChain({ sendValue: vi.fn(async () => Promise.reject(new Error("nonce too low"))) });
    expect((await handleDrip({ address: USER }, "ip", deps(failing, {}, store))).status).toBe(502);
    expect((await handleDrip({ address: USER }, "ip", deps(dripChain(), {}, store))).status).toBe(200);
  });
});

// ---------------------------------------------------------------- relay

async function signedRequest(overrides: { side?: 0 | 1; amount?: bigint; key?: Hex } = {}) {
  const account = privateKeyToAccount(overrides.key ?? generatePrivateKey());
  const { auth, typedData } = await prepareRelayedStake({
    client: { readContract: vi.fn() } as never,
    chainId: 10143,
    usdc: USDC_TOKEN,
    market: MARKET,
    user: account.address,
    side: overrides.side ?? 0,
    amount: overrides.amount ?? 10_000_000n,
    nowSeconds: NOW,
    domain: DOMAIN,
  });
  const signature = await account.signTypedData(typedData);
  const body = {
    market: auth.market,
    user: auth.user,
    side: auth.side,
    amount: auth.amount.toString(),
    validAfter: auth.validAfter.toString(),
    validBefore: auth.validBefore.toString(),
    salt: auth.salt,
    signature,
  };
  return { body, auth, account };
}

function relayChain(overrides: Partial<RelayChain> & { check?: Partial<MarketCheck> } = {}): RelayChain {
  const { check, ...rest } = overrides;
  return {
    relayer: RELAYER,
    chainId: 10143,
    checkMarket: vi.fn(async (r) => ({
      isMarket: true,
      phase: Phase.Pool,
      nonce: stakeAuthorizationNonce({
        chainId: 10143,
        market: r.market,
        user: r.user,
        side: r.side,
        salt: r.salt,
      }),
      minStake: 1_000_000n,
      ...check,
    })),
    usdcDomain: vi.fn(async () => DOMAIN),
    tokenState: vi.fn(async () => ({ used: false, balance: 1_000_000_000n })),
    submit: vi.fn(async () => `0x${"ff".repeat(32)}` as Hex),
    txUrl: (hash) => `https://testnet.monadscan.com/tx/${hash}`,
    ...rest,
  };
}

describe("POST /api/relay/stake", () => {
  it("submits a valid, signed stake and returns the hash", async () => {
    const { body } = await signedRequest();
    const chain = relayChain();
    const r = await handleRelayStake(body, "ip", deps(chain));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, hash: `0x${"ff".repeat(32)}` });
    expect(chain.submit).toHaveBeenCalledTimes(1);
  });

  it("answers 503 without a relayer key", async () => {
    const { body } = await signedRequest();
    const r = await handleRelayStake(body, "ip", { ...deps(relayChain()), config: parseRelayerConfig({}) });
    expect(r.status).toBe(503);
  });

  it("refuses before any chain read: bad body, expiry window, the size cap and mainnet", async () => {
    const chain = relayChain();
    expect((await handleRelayStake({ nope: 1 }, "ip", deps(chain))).status).toBe(400);
    const { body } = await signedRequest();
    expect(
      (await handleRelayStake({ ...body, validBefore: String(NOW + 9_999) }, "ip", deps(chain))).status,
    ).toBe(400);
    const big = await signedRequest({ amount: 2_000_000_000n });
    const tooBig = await handleRelayStake(big.body, "ip", deps(chain));
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toMatch(/up to 1,000.00 USDC/);
    expect((await handleRelayStake({ ...body, network: "monad-mainnet" }, "ip", deps(chain))).status).toBe(
      403,
    );
    expect(chain.checkMarket).not.toHaveBeenCalled();
  });

  it("caps per IP, per user and per day", async () => {
    const store = new MemoryStore(() => NOW_MS);
    const d = deps(relayChain(), { RELAY_USER_DAILY_CAP: "1" }, store);
    const key = generatePrivateKey();
    expect((await handleRelayStake((await signedRequest({ key })).body, "ip-a", d)).status).toBe(200);
    expect((await handleRelayStake((await signedRequest({ key })).body, "ip-b", d)).status).toBe(429);
    const perIp = deps(relayChain(), { RELAY_IP_DAILY_CAP: "0" });
    expect((await handleRelayStake((await signedRequest()).body, "ip", perIp)).status).toBe(429);
  });

  it("checks the market: a factory market, in its pool, above its minimum, with the market's nonce", async () => {
    const { body } = await signedRequest();
    const notMarket = await handleRelayStake(body, "ip", deps(relayChain({ check: { isMarket: false } })));
    expect(notMarket.status).toBe(400);
    expect(notMarket.body.error).toMatch(/not a Hunch Book market/);
    expect(
      (await handleRelayStake(body, "ip", deps(relayChain({ check: { phase: Phase.Graduated } })))).status,
    ).toBe(409);
    expect(
      (await handleRelayStake(body, "ip", deps(relayChain({ check: { minStake: 50_000_000n } })))).status,
    ).toBe(400);
    const wrongNonce = await handleRelayStake(body, "ip", deps(relayChain({ check: { nonce: SALT } })));
    expect(wrongNonce.status).toBe(400);
    expect(wrongNonce.body.error).toMatch(/nonce/);
  });

  it("refuses a signature from anyone but the user, or for another side", async () => {
    const { body } = await signedRequest({ side: 0 });
    // Same signature, but the request asks for NO: the nonce (and so the digest) changes.
    const flipped = await handleRelayStake({ ...body, side: 1 }, "ip", deps(relayChain()));
    expect(flipped.status).toBe(400);
    expect(flipped.body.error).toMatch(/not from this account/);
    const other = await signedRequest();
    const swapped = await handleRelayStake(
      { ...body, signature: other.body.signature },
      "ip",
      deps(relayChain()),
    );
    expect(swapped.status).toBe(400);
  });

  it("refuses a used authorisation or an account without the USDC", async () => {
    const { body } = await signedRequest();
    const used = relayChain({ tokenState: vi.fn(async () => ({ used: true, balance: 10n ** 12n })) });
    expect((await handleRelayStake(body, "ip", deps(used))).status).toBe(409);
    const poor = relayChain({ tokenState: vi.fn(async () => ({ used: false, balance: 1n })) });
    expect((await handleRelayStake(body, "ip", deps(poor))).status).toBe(400);
  });

  it("passes a failed simulation back in plain words", async () => {
    const { body } = await signedRequest();
    const chain = relayChain({
      submit: vi.fn(async () => Promise.reject(new Error("That stake would take the pool over its cap."))),
    });
    const r = await handleRelayStake(body, "ip", deps(chain));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("That stake would take the pool over its cap.");
  });
});

describe("browser client", () => {
  it("maps drip answers, including refusals and a dead network", async () => {
    const ok = await requestDrip(
      USER,
      "monad-testnet",
      async () =>
        new Response(JSON.stringify({ ok: true, hash: `0x${"aa".repeat(32)}`, url: "u", amountMon: "0.05" })),
    );
    expect(ok).toEqual({ ok: true, hash: `0x${"aa".repeat(32)}`, url: "u", amountMon: "0.05" });
    const refused = await requestDrip(
      USER,
      "monad-testnet",
      async () =>
        new Response(JSON.stringify({ ok: false, error: "no", reason: "cap", faucet: "f" }), { status: 429 }),
    );
    expect(refused).toEqual({ ok: false, error: "no", reason: "cap", faucet: "f" });
    const down = await requestDrip(USER, "monad-testnet", async () => {
      throw new TypeError("fetch failed");
    });
    expect(down.ok).toBe(false);
  });
});
