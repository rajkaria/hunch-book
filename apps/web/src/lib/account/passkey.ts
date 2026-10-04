import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
  type WebAuthnClient,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import type { Address, LocalAccount } from "viem";

// Passkey accounts (docs/ACCOUNTS.md, PROTOCOL.md §9.5). A passkey with the WebAuthn PRF extension
// gives 32 stable secret bytes for this domain. Mera turns them into an ordinary Monad account in the
// browser: PRF output -> BIP-39 entropy -> seed -> m/44'/60'/0'/0/0, the derivation Mera documents.
// The private key lives only inside a Mera signing session in this tab's memory, and is zeroed when
// the session ends. Nothing is sent to a server and nothing secret is stored.

/** The first Ethereum account path (BIP-44), as in Mera's own recipe. */
export const PASSKEY_DERIVATION_PATH = "m/44'/60'/0'/0/0";

/** What the authenticator shows next to the passkey. */
export const PASSKEY_RP_NAME = "Hunch Book";

/** A live passkey account: a viem local account backed by a Mera session, and the way to end it. */
export interface PasskeySession {
  address: Address;
  account: LocalAccount;
  credential: PasskeyCredentialMetadata;
  rpId: string;
  /** Zeroes the private key held by the session. Signing fails afterwards. */
  end(): void;
}

/**
 * The WebAuthn relying party id for a page host. Passkeys are bound to it, so the same passkey gives
 * the same account only on the same domain: book.playhunch.xyz in production, localhost in dev.
 * Returns null where WebAuthn cannot work: IP addresses and empty hosts.
 */
export function passkeyRpId(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  // WebAuthn rejects IP addresses as relying party ids.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return null;
  return host;
}

/** The 32-byte account key derived from a passkey's PRF output. The caller must zero it after use. */
export function derivePrivateKey(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length !== 32) throw new Error("The passkey returned an output of the wrong length.");
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  try {
    const root = HDKey.fromMasterSeed(seed);
    const node = root.derive(PASSKEY_DERIVATION_PATH);
    const key = node.privateKey;
    if (!key) throw new Error("The passkey did not derive a key.");
    const copy = new Uint8Array(key);
    node.wipePrivateData();
    root.wipePrivateData();
    return copy;
  } finally {
    seed.fill(0);
  }
}

/** Starts a Mera signing session for the account a PRF output derives. Zeroes the PRF output. */
export function sessionFromPrf(
  prfOutput: Uint8Array,
  credential: PasskeyCredentialMetadata,
  rpId: string,
): PasskeySession {
  const privateKey = derivePrivateKey(prfOutput);
  prfOutput.fill(0);
  try {
    const session = createSecp256k1SigningSession({ privateKey });
    const account = toViemAccount(session);
    return { address: account.address, account, credential, rpId, end: () => session.end() };
  } finally {
    // The session holds its own copy.
    privateKey.fill(0);
  }
}

export interface PasskeyCeremonyOptions {
  rpId: string;
  /** Tests pass a fake WebAuthn client; the browser default calls navigator.credentials. */
  webAuthnClient?: WebAuthnClient;
}

/**
 * Creates a new passkey for this domain and the account it derives. One or two passkey prompts:
 * some authenticators only give the PRF output on a second, sign-in prompt.
 */
export async function createPasskeyAccount({
  rpId,
  webAuthnClient,
  label,
}: PasskeyCeremonyOptions & { label: string }): Promise<PasskeySession> {
  const created = await createPasskeyWithPrfOutput({
    rp: { id: rpId, name: PASSKEY_RP_NAME },
    user: { name: label, displayName: label },
    ...(webAuthnClient ? { webAuthnClient } : {}),
  });
  const credential: PasskeyCredentialMetadata = {
    credentialId: created.credentialId,
    ...(created.transports ? { transports: created.transports } : {}),
  };
  return sessionFromPrf(created.prfOutput, credential, rpId);
}

/** Signs in with an existing passkey: the browser lets the person pick one saved for this domain. */
export async function signInWithPasskey({
  rpId,
  webAuthnClient,
  credential,
}: PasskeyCeremonyOptions & { credential?: PasskeyCredentialMetadata }): Promise<PasskeySession> {
  const result = await getPasskeyPrfOutput({
    rpId,
    ...(credential ? { credential } : {}),
    ...(webAuthnClient ? { webAuthnClient } : {}),
  });
  return sessionFromPrf(result.prfOutput, { credentialId: result.credentialId }, rpId);
}

/** A label for a new passkey, so a person can tell their passkeys apart in their password manager. */
export function newPasskeyLabel(now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `Hunch Book account (${day})`;
}

/** One sentence a person can act on, for any passkey failure. */
export function describePasskeyError(error: unknown): string {
  if (isMeraError(error)) {
    switch (error.code) {
      case "PRF_UNAVAILABLE":
        return "This passkey cannot make an account: your browser or password manager does not support the passkey feature it needs (WebAuthn PRF). Try Chrome, Safari 18 or later, or a browser wallet.";
      case "PASSKEY_OPERATION_FAILED":
        return "The passkey prompt was closed or failed. Nothing was created. Try again.";
      case "CRYPTO_UNAVAILABLE":
        return "This browser lacks the secure random numbers a passkey account needs. Use a current browser over https.";
      case "SESSION_ENDED":
        return "Your passkey session ended. Sign in with your passkey again.";
      default:
        return "The passkey could not be used. Try again.";
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return "The passkey could not be used. Try again.";
}

export type PasskeySupport =
  | { supported: true; prf: "yes" | "unknown" }
  | { supported: false; reason: string };

/**
 * Whether this page can make passkey accounts. WebAuthn needs a secure context (https or localhost)
 * and a host that can be a relying party id. Browsers that report their capabilities also say
 * whether PRF works; the others are tried, and a failure says so in plain words.
 */
export async function passkeySupport(): Promise<PasskeySupport> {
  if (typeof window === "undefined")
    return { supported: false, reason: "Passkeys work in the browser only." };
  if (!window.isSecureContext) {
    return { supported: false, reason: "Passkeys need a secure page (https or localhost)." };
  }
  if (passkeyRpId(window.location.hostname) === null) {
    return {
      supported: false,
      reason: "Passkeys do not work on an IP address. Open the app on localhost or its domain.",
    };
  }
  const pkc = (window as { PublicKeyCredential?: unknown }).PublicKeyCredential as
    | { getClientCapabilities?: () => Promise<Record<string, boolean | undefined>> }
    | undefined;
  if (!pkc) return { supported: false, reason: "This browser does not support passkeys." };
  try {
    const caps = await pkc.getClientCapabilities?.();
    if (caps && caps["extension:prf"] === false) {
      return {
        supported: false,
        reason:
          "This browser cannot make an account from a passkey (no WebAuthn PRF support). Try Chrome, Safari 18 or later, or a browser wallet.",
      };
    }
    return { supported: true, prf: caps?.["extension:prf"] === true ? "yes" : "unknown" };
  } catch {
    return { supported: true, prf: "unknown" };
  }
}
