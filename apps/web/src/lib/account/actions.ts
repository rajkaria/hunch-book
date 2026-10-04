import type { WebAuthnClient } from "@category-labs/mera";
import {
  createPasskeyAccount,
  newPasskeyLabel,
  type PasskeySession,
  passkeyRpId,
  signInWithPasskey,
} from "./passkey";
import { setActivePasskey } from "./session";
import { rememberedPasskeys, rememberPasskey } from "./storage";

// The two passkey flows the app offers. Each one runs the browser's passkey prompt, makes the
// resulting session the live one and remembers the (public) account details in this browser.

export type PasskeyFlow = "create" | "sign-in";

/** The relying party id for this page, or an error a person can act on. */
export function currentRpId(): string {
  const rpId = typeof window === "undefined" ? null : passkeyRpId(window.location.hostname);
  if (!rpId)
    throw new Error("Passkeys do not work on this address. Open the app on its domain or localhost.");
  return rpId;
}

export async function startPasskeySession(
  flow: PasskeyFlow,
  { webAuthnClient, now = () => Date.now() }: { webAuthnClient?: WebAuthnClient; now?: () => number } = {},
): Promise<PasskeySession> {
  const rpId = currentRpId();
  const session =
    flow === "create"
      ? await createPasskeyAccount({
          rpId,
          label: newPasskeyLabel(new Date(now())),
          ...(webAuthnClient ? { webAuthnClient } : {}),
        })
      : await signInWithPasskey({ rpId, ...(webAuthnClient ? { webAuthnClient } : {}) });
  // A sign-in reports only the credential id; keep the transports this browser saw at creation.
  const known = rememberedPasskeys(rpId).find(
    (r) => r.credential.credentialId === session.credential.credentialId,
  );
  rememberPasskey({
    address: session.address,
    rpId,
    lastUsed: now(),
    credential: known && !session.credential.transports ? known.credential : session.credential,
  });
  setActivePasskey(session);
  return session;
}
