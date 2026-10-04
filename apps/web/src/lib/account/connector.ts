import {
  type Address,
  type Chain,
  createWalletClient,
  fromHex,
  type Hex,
  http,
  numberToHex,
  type TypedDataDefinition,
  type WalletClient,
} from "viem";
import { createConnector } from "wagmi";
import { startPasskeySession } from "./actions";
import type { PasskeySession } from "./passkey";
import { activePasskey, endActivePasskey, setActivePasskey, subscribePasskey } from "./session";

// A wagmi connector for passkey accounts. The account is a plain EOA whose key lives in a Mera
// session in this tab, so the connector hands wagmi a viem wallet client with that local account:
// every existing action (useWriteContract, useSignTypedData, the tx runner) signs in the browser
// and sends raw transactions to the deployment's RPC. No extension, no custody, no paymaster.

export const PASSKEY_CONNECTOR_ID = "hunch-passkey";
export const PASSKEY_CONNECTOR_TYPE = "passkey";

/** The part of EIP-1193 this connector's provider answers. */
export interface PasskeyProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export interface PasskeyConnectorOptions {
  /** Runs when wagmi connects with no live session. Default: the browser's passkey sign-in. */
  signIn?: () => Promise<PasskeySession>;
}

class NotConnectedError extends Error {
  override name = "ConnectorNotConnectedError";
  constructor() {
    super("No passkey account is signed in. Sign in with your passkey first.");
  }
}

interface TxParams {
  to?: Address;
  data?: Hex;
  value?: Hex;
  gas?: Hex;
  nonce?: Hex;
}

/** EIP-1193 requests a passkey account answers itself; everything else goes to the chain's RPC. */
export function passkeyProvider(
  session: () => PasskeySession,
  client: () => WalletClient,
  chainId: () => number,
  switchChain: (id: number) => void,
): PasskeyProvider {
  return {
    async request({ method, params }) {
      const list = (Array.isArray(params) ? params : []) as unknown[];
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [session().address];
        case "eth_chainId":
          return numberToHex(chainId());
        case "wallet_addEthereumChain":
          return null;
        case "wallet_switchEthereumChain": {
          const target = (list[0] as { chainId?: Hex } | undefined)?.chainId;
          if (!target) throw new Error("wallet_switchEthereumChain needs a chain id");
          switchChain(fromHex(target, "number"));
          return null;
        }
        case "personal_sign":
          return session().account.signMessage({ message: { raw: list[0] as Hex } });
        case "eth_signTypedData_v4": {
          const raw = list[1];
          const typed = (typeof raw === "string" ? JSON.parse(raw) : raw) as TypedDataDefinition;
          return session().account.signTypedData?.(typed);
        }
        case "eth_sendTransaction": {
          const tx = (list[0] ?? {}) as TxParams;
          const wallet = client();
          return wallet.sendTransaction({
            account: session().account,
            chain: wallet.chain,
            ...(tx.to ? { to: tx.to } : {}),
            ...(tx.data ? { data: tx.data } : {}),
            ...(tx.value ? { value: fromHex(tx.value, "bigint") } : {}),
            ...(tx.gas ? { gas: fromHex(tx.gas, "bigint") } : {}),
            ...(tx.nonce ? { nonce: fromHex(tx.nonce, "number") } : {}),
          } as never);
        }
        default:
          return client().request({ method, params } as never);
      }
    },
  };
}

export function passkeyConnector(options: PasskeyConnectorOptions = {}) {
  const signIn = options.signIn ?? (() => startPasskeySession("sign-in"));

  return createConnector<PasskeyProvider>((config) => {
    let chainId = config.chains[0].id;
    let connected = false;
    let lastAddress: Address | null = null;
    // One subscription for the life of the app: the connector lives as long as the wagmi config.
    let watching = false;
    const watch = () => {
      if (watching) return;
      watching = true;
      subscribePasskey(onSessionChange);
    };

    const chainOf = (id?: number): Chain =>
      config.chains.find((c) => c.id === (id ?? chainId)) ?? config.chains[0];

    const session = (): PasskeySession => {
      const s = activePasskey();
      if (!s) throw new NotConnectedError();
      return s;
    };

    const walletClient = (id?: number): WalletClient => {
      const chain = chainOf(id);
      const transport = config.transports?.[chain.id] ?? http(chain.rpcUrls.default.http[0]);
      return createWalletClient({ account: session().account, chain, transport });
    };

    const switchTo = (id: number): Chain => {
      const chain = config.chains.find((c) => c.id === id);
      if (!chain) throw new Error(`Chain ${id} is not configured in this app.`);
      chainId = chain.id;
      config.emitter.emit("change", { chainId });
      return chain;
    };

    // A session that ends or changes outside wagmi (another tab of the UI, a sign-in with a different
    // passkey) is reported to wagmi, so the app never shows an account it can no longer sign for.
    const onSessionChange = () => {
      if (!connected) return;
      const s = activePasskey();
      if (!s) {
        connected = false;
        lastAddress = null;
        config.emitter.emit("disconnect");
      } else if (s.address !== lastAddress) {
        lastAddress = s.address;
        config.emitter.emit("change", { accounts: [s.address] });
      }
    };

    return {
      id: PASSKEY_CONNECTOR_ID,
      name: "Passkey account",
      type: PASSKEY_CONNECTOR_TYPE,

      async setup() {
        watch();
      },

      async connect({ chainId: wanted } = {}) {
        let s = activePasskey();
        if (!s) {
          s = await signIn();
          if (activePasskey() !== s) setActivePasskey(s);
        }
        if (wanted !== undefined && config.chains.some((c) => c.id === wanted)) chainId = wanted;
        connected = true;
        lastAddress = s.address;
        watch();
        // wagmi's generic return type also covers `withCapabilities`, which this connector does not offer.
        return { accounts: [s.address], chainId } as never;
      },

      async disconnect() {
        connected = false;
        lastAddress = null;
        endActivePasskey();
      },

      async getAccounts() {
        return [session().address];
      },

      async getChainId() {
        return chainId;
      },

      async getProvider() {
        return passkeyProvider(
          session,
          () => walletClient(),
          () => chainId,
          switchTo,
        );
      },

      async getClient({ chainId: id } = {}) {
        return walletClient(id);
      },

      // The key is never stored, so a reload cannot reconnect without a new passkey prompt.
      async isAuthorized() {
        return activePasskey() !== null && connected;
      },

      async switchChain({ chainId: id }) {
        return switchTo(id);
      },

      onAccountsChanged(accounts) {
        if (accounts.length === 0) this.onDisconnect();
        else config.emitter.emit("change", { accounts: accounts as Address[] });
      },

      onChainChanged(chain) {
        config.emitter.emit("change", { chainId: Number(chain) });
      },

      onDisconnect() {
        connected = false;
        lastAddress = null;
        config.emitter.emit("disconnect");
      },
    };
  });
}
