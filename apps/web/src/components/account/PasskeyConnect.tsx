"use client";

import { isMeraError } from "@category-labs/mera";
import { useEffect, useState } from "react";
import { useConnect, useConnectors } from "wagmi";
import { currentRpId, type PasskeyFlow, startPasskeySession } from "@/lib/account/actions";
import { PASSKEY_CONNECTOR_ID } from "@/lib/account/connector";
import { usePasskeySupport } from "@/lib/account/hooks";
import { describePasskeyError } from "@/lib/account/passkey";
import { type RememberedPasskey, rememberedPasskeys } from "@/lib/account/storage";
import { SITE_URL } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { describeTxError } from "@/lib/wallet/errors";
import layout from "../layout/layout.module.css";
import { Button } from "../ui";
import s from "./account.module.css";

const PRODUCTION_HOST = new URL(SITE_URL).host;

/** The passkey part of the connect menu: create an account, or sign in to one. */
export function PasskeyConnect() {
  const connector = useConnectors().find((c) => c.id === PASSKEY_CONNECTOR_ID);
  const connect = useConnect();
  const support = usePasskeySupport();
  const [busy, setBusy] = useState<PasskeyFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [last, setLast] = useState<RememberedPasskey | null>(null);

  useEffect(() => {
    setHost(window.location.host);
    try {
      setLast(rememberedPasskeys(currentRpId())[0] ?? null);
    } catch {
      setLast(null);
    }
  }, []);

  if (!connector) return null;

  const run = async (flow: PasskeyFlow) => {
    setBusy(flow);
    setError(null);
    try {
      await startPasskeySession(flow);
      await connect.mutateAsync({ connector });
    } catch (e) {
      setError(isMeraError(e) ? describePasskeyError(e) : describeTxError(e));
    } finally {
      setBusy(null);
    }
  };

  const otherDomain = host !== null && host !== PRODUCTION_HOST;

  return (
    <>
      <p className={layout.menuHeading}>Passkey account</p>
      <div className={s.section}>
        {support && !support.supported ? (
          <p className={s.note}>{support.reason}</p>
        ) : (
          <div className={s.actions}>
            <Button
              size="sm"
              variant="primary"
              block
              loading={busy === "create"}
              disabled={busy !== null}
              onClick={() => void run("create")}
            >
              Create a passkey account
            </Button>
            <Button
              size="sm"
              block
              loading={busy === "sign-in"}
              disabled={busy !== null}
              onClick={() => void run("sign-in")}
            >
              Sign in with passkey
            </Button>
          </div>
        )}
        {last ? (
          <p className={s.remembered}>Last passkey account on this browser: {shortAddress(last.address)}</p>
        ) : null}
        {error ? (
          <p className={s.error} role="alert">
            {error}
          </p>
        ) : null}
        <p className={s.note}>
          No seed phrase and no extension. Your passkey derives an ordinary Monad account in this browser; the
          key never leaves it and nobody holds it for you.
        </p>
        <p className={s.small}>
          A passkey belongs to one website.{" "}
          {otherDomain
            ? `This page is ${host}, so the account here differs from the one at ${PRODUCTION_HOST}.`
            : `Use ${PRODUCTION_HOST} to get the same account every time.`}
        </p>
      </div>
    </>
  );
}
