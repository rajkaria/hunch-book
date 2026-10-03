import { type Chain, numberToHex } from "viem";

/** The part of an EIP-1193 provider the network switch needs. */
export interface Eip1193Like {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export interface AddChainParameters {
  chainId: `0x${string}`;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

/** EIP-3085 parameters for `wallet_addEthereumChain`, with the deployment's RPC first. */
export function addChainParameters(chain: Chain, rpcUrl: string): AddChainParameters {
  const rpcUrls = [rpcUrl, ...chain.rpcUrls.default.http.filter((u) => u !== rpcUrl)];
  const explorer = chain.blockExplorers?.default.url;
  return {
    chainId: numberToHex(chain.id),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls,
    ...(explorer ? { blockExplorerUrls: [explorer] } : {}),
  };
}

/** True when the person said no in their wallet (EIP-1193 code 4001, or a wallet's own wording). */
export function isUserRejection(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const e = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (e.code === 4001 || e.name === "UserRejectedRequestError") return true;
    if (typeof e.message === "string" && /user (rejected|denied)|rejected the request/i.test(e.message))
      return true;
    current = e.cause;
  }
  return false;
}

/**
 * Adds the chain, then switches to it. Asking to add first works with wallets that never return
 * error 4902 for an unknown chain. If adding fails for any reason other than the person saying no
 * (for example, the wallet already knows the chain and refuses a duplicate), the switch still runs.
 */
export async function addThenSwitch(provider: Eip1193Like, chain: Chain, rpcUrl: string): Promise<void> {
  const params = addChainParameters(chain, rpcUrl);
  try {
    await provider.request({ method: "wallet_addEthereumChain", params: [params] });
  } catch (error) {
    if (isUserRejection(error)) throw error;
  }
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: params.chainId }] });
}
