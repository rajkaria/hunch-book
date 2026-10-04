import { createHash } from "node:crypto";
import { MeraError, type WebAuthnClient } from "@category-labs/mera";
import { monadTestnet } from "@hunch-book/shared";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { recoverTypedDataAddress } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfig, http } from "wagmi";
import { connect, disconnect, getConnectorClient, signTypedData } from "wagmi/actions";
import { PASSKEY_CONNECTOR_ID, PASSKEY_CONNECTOR_TYPE, passkeyConnector } from "../src/lib/account/connector";
import {
  createPasskeyAccount,
  derivePrivateKey,
  describePasskeyError,
  PASSKEY_DERIVATION_PATH,
  passkeyRpId,
  sessionFromPrf,
  signInWithPasskey,
} from "../src/lib/account/passkey";
import { activePasskey, endActivePasskey, setActivePasskey } from "../src/lib/account/session";
import {
  forgetPasskey,
  PASSKEY_STORAGE_KEY,
  rememberedPasskeys,
  rememberPasskey,
} from "../src/lib/account/storage";

// A software authenticator: the PRF output is a fixed function of the credential and the salt, as a
// real passkey's is, so "the same passkey gives the same account" can be tested end to end.
function fakeAuthenticator() {
  const credentials: Uint8Array[] = [];
  const prf = (id: Uint8Array, salt: Uint8Array) =>
    new Uint8Array(createHash("sha256").update(id).update(salt).digest());
  const client: WebAuthnClient = {
    async createCredential(request) {
      const id = new Uint8Array(createHash("sha256").update(`cred-${credentials.length}`).digest()).slice(
        0,
        16,
      );
      credentials.push(id);
      return {
        credentialId: id,
        transports: ["internal"],
        prfEnabled: true,
        prfOutput: prf(id, request.prfSalt),
      };
    },
    async getCredential(request) {
      const id = request.allowCredential?.credentialId ?? credentials.at(-1);
      if (!id) throw new Error("no passkey for this site");
      return { credentialId: id, prfOutput: prf(id, request.prfSalt) };
    },
  };
  return { client, credentials };
}

const prfOf = (seed: string) => new Uint8Array(createHash("sha256").update(seed).digest());

afterEach(() => {
  endActivePasskey();
});

describe("relying party id", () => {
  it("uses the page host, lowercased", () => {
    expect(passkeyRpId("book.playhunch.xyz")).toBe("book.playhunch.xyz");
    expect(passkeyRpId("Book.PlayHunch.xyz.")).toBe("book.playhunch.xyz");
    expect(passkeyRpId("localhost")).toBe("localhost");
  });

  it("refuses hosts WebAuthn cannot use", () => {
    expect(passkeyRpId("127.0.0.1")).toBeNull();
    expect(passkeyRpId("::1")).toBeNull();
    expect(passkeyRpId("")).toBeNull();
  });
});

describe("key derivation", () => {
  it("follows Mera's recipe: PRF output as BIP-39 entropy, then m/44'/60'/0'/0/0", () => {
    const prf = prfOf("passkey one");
    const expected = mnemonicToAccount(entropyToMnemonic(prf, wordlist), { path: PASSKEY_DERIVATION_PATH });
    const session = sessionFromPrf(new Uint8Array(prf), { credentialId: "AQ" }, "localhost");
    expect(session.address).toBe(expected.address);
    expect(PASSKEY_DERIVATION_PATH).toBe("m/44'/60'/0'/0/0");
    session.end();
  });

  it("gives the same account for the same PRF output and a different one otherwise", () => {
    const a = derivePrivateKey(prfOf("x"));
    const b = derivePrivateKey(prfOf("x"));
    const c = derivePrivateKey(prfOf("y"));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it("refuses a PRF output of the wrong length", () => {
    expect(() => derivePrivateKey(new Uint8Array(16))).toThrow(/wrong length/);
  });

  it("zeroes the PRF output it was given, and signing stops once the session ends", async () => {
    const prf = prfOf("zero me");
    const session = sessionFromPrf(prf, { credentialId: "AQ" }, "localhost");
    expect(prf.every((b) => b === 0)).toBe(true);
    const signature = await session.account.signMessage({ message: "hello" });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    session.end();
    await expect(session.account.signMessage({ message: "hello" })).rejects.toThrow(/ended/i);
  });

  it("signs EIP-712 typed data that recovers to the account (the relayed-stake path)", async () => {
    const session = sessionFromPrf(prfOf("typed"), { credentialId: "AQ" }, "localhost");
    const typed = {
      domain: {
        name: "Hunch Book Test USDC",
        version: "1",
        chainId: 10143,
        verifyingContract: session.address,
      },
      types: { Ping: [{ name: "n", type: "uint256" }] },
      primaryType: "Ping" as const,
      message: { n: 7n },
    };
    const signature = await session.account.signTypedData?.(typed);
    expect(signature).toBeDefined();
    // v is 27 or 28: the byte Market.stakeWithAuthorization reads from signature[64].
    expect(["1b", "1c"]).toContain(signature?.slice(-2));
    expect(await recoverTypedDataAddress({ ...typed, signature: signature as `0x${string}` })).toBe(
      session.address,
    );
    session.end();
  });
});

describe("passkey ceremonies", () => {
  it("creates a passkey and signs back in to the same account", async () => {
    const auth = fakeAuthenticator();
    const created = await createPasskeyAccount({
      rpId: "localhost",
      label: "test",
      webAuthnClient: auth.client,
    });
    expect(created.credential.transports).toEqual(["internal"]);
    const again = await signInWithPasskey({ rpId: "localhost", webAuthnClient: auth.client });
    expect(again.address).toBe(created.address);
    expect(again.credential.credentialId).toBe(created.credential.credentialId);
    created.end();
    again.end();
  });

  it("explains every Mera failure in plain words", () => {
    expect(describePasskeyError(new MeraError("PRF_UNAVAILABLE", "x"))).toMatch(/PRF/);
    expect(describePasskeyError(new MeraError("PASSKEY_OPERATION_FAILED", "x"))).toMatch(/closed or failed/);
    expect(describePasskeyError(new MeraError("SESSION_ENDED", "x"))).toMatch(/again/);
    expect(describePasskeyError(new Error("custom"))).toBe("custom");
    expect(describePasskeyError("??")).toMatch(/could not be used/);
  });
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

describe("remembered passkey accounts", () => {
  const entry = (address: `0x${string}`, lastUsed: number, rpId = "localhost") => ({
    address,
    rpId,
    lastUsed,
    credential: { credentialId: "AQID", transports: ["internal"] },
  });

  it("keeps public details only, newest first, one per address and domain", () => {
    const store = memoryStorage();
    rememberPasskey(entry("0x00000000000000000000000000000000000000b1", 1), store);
    rememberPasskey(entry("0x00000000000000000000000000000000000000b2", 2), store);
    rememberPasskey(entry("0x00000000000000000000000000000000000000b1", 3), store);
    rememberPasskey(entry("0x00000000000000000000000000000000000000b3", 4, "book.playhunch.xyz"), store);
    const local = rememberedPasskeys("localhost", store);
    expect(local.map((r) => r.lastUsed)).toEqual([3, 2]);
    expect(rememberedPasskeys("book.playhunch.xyz", store)).toHaveLength(1);
    expect(store.map.get(PASSKEY_STORAGE_KEY)).not.toMatch(/private|prf|seed/i);
    forgetPasskey("0x00000000000000000000000000000000000000B1", "localhost", store);
    expect(rememberedPasskeys("localhost", store).map((r) => r.lastUsed)).toEqual([2]);
  });

  it("survives bad data and a store that throws", () => {
    const store = memoryStorage();
    store.setItem(PASSKEY_STORAGE_KEY, "{not json");
    expect(rememberedPasskeys("localhost", store)).toEqual([]);
    store.setItem(PASSKEY_STORAGE_KEY, JSON.stringify([{ address: "nope" }, 5]));
    expect(rememberedPasskeys("localhost", store)).toEqual([]);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(rememberedPasskeys("localhost", broken)).toEqual([]);
    expect(() =>
      rememberPasskey(entry("0x00000000000000000000000000000000000000b1", 1), broken),
    ).not.toThrow();
    expect(() =>
      forgetPasskey("0x00000000000000000000000000000000000000b1", "localhost", broken),
    ).not.toThrow();
  });
});

describe("passkey wagmi connector", () => {
  function setup(
    signIn = vi.fn(async () => sessionFromPrf(prfOf("connector"), { credentialId: "AQ" }, "localhost")),
  ) {
    const config = createConfig({
      chains: [monadTestnet],
      connectors: [passkeyConnector({ signIn })],
      transports: { [monadTestnet.id]: http("http://127.0.0.1:9") },
      multiInjectedProviderDiscovery: false,
      storage: null,
    });
    const connector = config.connectors.find((c) => c.id === PASSKEY_CONNECTOR_ID);
    if (!connector) throw new Error("connector missing");
    return { config, connector, signIn };
  }

  it("is listed as a passkey connector", () => {
    const { connector } = setup();
    expect(connector.type).toBe(PASSKEY_CONNECTOR_TYPE);
    expect(connector.name).toBe("Passkey account");
  });

  it("signs in on connect when no session is live, and signs through wagmi in the browser", async () => {
    const { config, connector, signIn } = setup();
    const result = await connect(config, { connector });
    expect(signIn).toHaveBeenCalledTimes(1);
    const session = activePasskey();
    expect(result.accounts[0]).toBe(session?.address);
    expect(result.chainId).toBe(monadTestnet.id);

    const typed = {
      domain: { name: "T", version: "1", chainId: monadTestnet.id },
      types: { Ping: [{ name: "n", type: "uint256" }] },
      primaryType: "Ping" as const,
      message: { n: 1n },
    };
    const signature = await signTypedData(config, typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(session?.address);

    const client = await getConnectorClient(config);
    expect(client.account.address).toBe(session?.address);
    expect(client.account.type).toBe("local");
    await disconnect(config);
  });

  it("reuses a live session without a second prompt", async () => {
    const { config, connector, signIn } = setup();
    setActivePasskey(sessionFromPrf(prfOf("already"), { credentialId: "AQ" }, "localhost"));
    await connect(config, { connector });
    expect(signIn).not.toHaveBeenCalled();
    await disconnect(config);
  });

  it("ends the session (zeroing its key) on disconnect, so nothing can sign afterwards", async () => {
    const { config, connector } = setup();
    await connect(config, { connector });
    const session = activePasskey();
    await disconnect(config);
    expect(activePasskey()).toBeNull();
    expect(await connector.isAuthorized()).toBe(false);
    await expect(session?.account.signMessage({ message: "x" })).rejects.toThrow(/ended/i);
  });

  it("tells wagmi when the session ends outside it", async () => {
    const { config, connector } = setup();
    await connect(config, { connector });
    expect(config.state.status).toBe("connected");
    endActivePasskey();
    expect(config.state.status).toBe("disconnected");
  });

  it("answers the EIP-1193 calls the app makes", async () => {
    const { config, connector } = setup();
    await connect(config, { connector });
    const provider = (await connector.getProvider()) as {
      request(a: { method: string; params?: unknown }): Promise<unknown>;
    };
    const address = activePasskey()?.address;
    expect(await provider.request({ method: "eth_accounts" })).toEqual([address]);
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x279f");
    expect(await provider.request({ method: "wallet_addEthereumChain", params: [{}] })).toBeNull();
    expect(
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] }),
    ).toBeNull();
    await expect(
      provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }),
    ).rejects.toThrow(/not configured/);
    await disconnect(config);
  });
});
