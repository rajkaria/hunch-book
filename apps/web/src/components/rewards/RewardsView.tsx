"use client";

import { merkleDistributorAbi } from "@hunch-book/shared";
import { useMemo } from "react";
import type { Abi, Address } from "viem";
import { appNetwork, appNetworkLabel, REPO_URL } from "@/lib/config";
import { formatFixed, formatInt, formatUtc } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { peripheryMessage } from "@/lib/periphery";
import { type EpochFile, parseEpochFile } from "@/lib/rewards/epochs";
import {
  merkleDistributorAddress,
  rewardsUrl,
  useEpochCount,
  useOnchainEpochs,
  useRemoteEpochs,
  useTokenInfo,
} from "@/lib/rewards/hooks";
import type { SerializedEpoch } from "@/lib/rewards/load";
import { CLAIM_STATE_LABEL, type ClaimState, type ClaimStatus, claimStatus } from "@/lib/rewards/status";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, useTxRunner } from "@/lib/wallet/useTxRunner";
import { TxList } from "../market/TxList";
import { EmptyState } from "../states";
import { AddressLink, Badge, Button, Notice, Panel, Stat, type Tone } from "../ui";
import { ConnectButton } from "../wallet/ConnectButton";
import s from "./rewards.module.css";

export const REWARDS_DOCS_URL = `${REPO_URL}/blob/main/docs/PERIPHERY.md#merkledistributor`;

const STATE_TONE: Record<ClaimState, Tone> = {
  claimable: "accent",
  claimed: "yes",
  none: "muted",
  "bad-proof": "danger",
  "not-onchain": "warn",
  "root-mismatch": "danger",
  expired: "muted",
};

const KIND_LABEL: Record<NonNullable<EpochFile["kind"]>, string> = {
  maker: "Maker rewards",
  referral: "Referral shares",
  mixed: "Maker rewards and referral shares",
};

/** Published files first, then any from NEXT_PUBLIC_REWARDS_URL for epochs not already listed. */
export function mergeEpochs(published: readonly EpochFile[], remote: readonly EpochFile[]): EpochFile[] {
  const seen = new Set(published.map((f) => f.epoch.toString()));
  const merged = [...published, ...remote.filter((f) => !seen.has(f.epoch.toString()))];
  return merged.sort((a, b) => (a.epoch === b.epoch ? 0 : a.epoch > b.epoch ? -1 : 1));
}

/** The /rewards page body: every published epoch, what the connected wallet can claim, and a claim. */
export function RewardsView({ published, errors }: { published: SerializedEpoch[]; errors: string[] }) {
  const distributor = merkleDistributorAddress();
  const wallet = useAppChain();
  const user = wallet.address;
  const now = useNow(30_000);
  const remote = useRemoteEpochs();
  const count = useEpochCount();
  const local = useMemo(() => published.map((p) => parseEpochFile(p, p.source)), [published]);
  const files = useMemo(() => mergeEpochs(local, remote.data?.files ?? []), [local, remote.data]);
  const onchain = useOnchainEpochs(files, user);
  const tokens = useTokenInfo(files.map((f) => f.token));
  const tx = useTxRunner([["rewards", appNetwork]]);
  const allErrors = [
    ...errors,
    ...(remote.data?.errors ?? []),
    ...(remote.isError ? ["The rewards URL could not be read."] : []),
  ];

  if (!distributor) {
    return (
      <Notice tone="warn" title="Rewards are not deployed here yet">
        The rewards distributor is not deployed on {appNetworkLabel}, so there is nothing to claim yet.
      </Notice>
    );
  }

  const t = now ?? Math.floor(Date.now() / 1000);
  const statuses: (ClaimStatus | null)[] = files.map((f, i) => {
    if (!user) return null;
    const row = onchain.data?.[i];
    return row ? claimStatus(f, user, row.epoch, row.claimed, t) : null;
  });
  const tokenOf = (f: EpochFile) =>
    tokens.data?.get(f.token.toLowerCase()) ?? { symbol: "tokens", decimals: 6 };
  const amount = (f: EpochFile, value: bigint) => {
    const info = tokenOf(f);
    return `${formatFixed(value, info.decimals, { minDecimals: 2, maxDecimals: Math.min(info.decimals, 6) })} ${info.symbol}`;
  };

  const claimable = files.flatMap((f, i) => {
    const st = statuses[i];
    return st?.state === "claimable" && st.claim ? [{ file: f, claim: st.claim }] : [];
  });
  const sumBy = (state: ClaimState) =>
    statuses.reduce((sum, st) => (st?.state === state && st.claim ? sum + st.claim.amount : sum), 0n);
  const sameToken = files.every((f) => f.token.toLowerCase() === files[0]?.token.toLowerCase());

  const claimOne = (f: EpochFile, st: ClaimStatus) => {
    if (!user || !st.claim) return;
    void tx.run(
      `Claim epoch ${f.epoch.toString()}: ${amount(f, st.claim.amount)}`,
      {
        address: distributor,
        abi: merkleDistributorAbi as Abi,
        functionName: "claim",
        args: [f.epoch, st.claim.account, st.claim.amount, st.claim.proof],
      },
      user,
    );
  };
  const claimAll = () => {
    if (!user || claimable.length === 0) return;
    void tx.run(
      `Claim ${formatInt(claimable.length)} reward epochs`,
      {
        address: distributor,
        abi: merkleDistributorAbi as Abi,
        functionName: "claimMany",
        args: [
          claimable.map(({ file, claim }) => ({
            epoch: file.epoch,
            account: claim.account,
            amount: claim.amount,
            proof: claim.proof,
          })),
        ],
      },
      user,
    );
  };

  return (
    <div className={s.stack}>
      <Panel title="Your rewards" labelledBy="rewards-title">
        {!user ? (
          <div className={s.connect}>
            <p className={s.note}>
              Connect a wallet to see what it can claim. Claims are read from the published files.
            </p>
            <ConnectButton />
          </div>
        ) : (
          <>
            <div className={s.stats}>
              <Stat
                label="Ready to claim"
                value={
                  files.length > 0 && sameToken
                    ? amount(files[0] as EpochFile, sumBy("claimable"))
                    : formatInt(claimable.length)
                }
                hint={
                  sameToken
                    ? `${formatInt(claimable.length)} ${claimable.length === 1 ? "epoch" : "epochs"}`
                    : "epochs"
                }
              />
              <Stat
                label="Claimed"
                value={
                  files.length > 0 && sameToken ? amount(files[0] as EpochFile, sumBy("claimed")) : "n/a"
                }
                hint="by this wallet"
              />
              <Stat
                label="Epochs onchain"
                value={count.data === undefined ? "..." : formatInt(count.data)}
                hint="created by the funder"
              />
            </div>
            <div className={s.row}>
              <Button
                variant="primary"
                disabled={claimable.length === 0 || tx.busy || !wallet.onAppChain}
                onClick={claimAll}
              >
                {tx.busy
                  ? stageText(tx.stage)
                  : claimable.length > 1
                    ? `Claim all ${formatInt(claimable.length)}`
                    : "Claim"}
              </Button>
              {wallet.wrongNetwork ? <ConnectButton /> : null}
            </div>
            <p className={s.note}>
              A claim pays the wallet named in the epoch, never whoever sends it. The proof is checked here
              first, then again by the contract.
            </p>
          </>
        )}
        {tx.error ? (
          <p className={s.error} role="alert">
            {peripheryMessage(tx.error)}
          </p>
        ) : null}
        <TxList txs={tx.txs} />
      </Panel>

      {allErrors.length > 0 ? (
        <Notice tone="warn" title="Some reward files could not be read">
          <ul className={s.errors}>
            {allErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {files.length === 0 ? (
        <EmptyState label="Rewards" title="No reward epochs are published yet">
          <p>
            Maker rewards (for quoting both sides close to the price) and referral shares (a part of the
            protocol's fees paid by referred wallets) are planned to be paid in weekly epochs from the rewards
            distributor <AddressLink address={distributor as Address} />. Each epoch's file appears here with
            your proof, and you claim it with one transaction.{" "}
            <a href={REWARDS_DOCS_URL} target="_blank" rel="noreferrer">
              How payouts are computed
            </a>
            .
          </p>
        </EmptyState>
      ) : (
        <Panel title="Epochs" labelledBy="epochs-title">
          <ul className={s.epochs}>
            {files.map((f, i) => {
              const st = statuses[i];
              const row = onchain.data?.[i];
              return (
                <li className={s.epoch} key={`${f.epoch.toString()}-${f.source}`}>
                  <div className={s.epochHead}>
                    <span className={s.epochTitle}>
                      Epoch {f.epoch.toString()}
                      {f.kind ? <span className={s.kind}> · {KIND_LABEL[f.kind]}</span> : null}
                    </span>
                    {st ? (
                      <Badge tone={STATE_TONE[st.state]} dot>
                        {CLAIM_STATE_LABEL[st.state]}
                      </Badge>
                    ) : null}
                  </div>
                  <p className={s.note}>
                    Total {amount(f, f.total)} to {formatInt(f.claims.length)}{" "}
                    {f.claims.length === 1 ? "wallet" : "wallets"}
                    {row?.epoch && row.epoch.claimDeadline > 0n
                      ? `, claim by ${formatUtc(row.epoch.claimDeadline)}`
                      : ""}
                    . Source: <span className="mono">{f.source}</span>.
                  </p>
                  {st?.claim ? (
                    <div className={s.mine}>
                      <span>
                        Yours: <strong className="mono">{amount(f, st.claim.amount)}</strong>
                      </span>
                      {st.state === "claimable" ? (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={tx.busy || !wallet.onAppChain}
                          onClick={() => claimOne(f, st)}
                        >
                          Claim
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {st ? <p className={s.note}>{st.note}</p> : null}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      <p className={s.note}>
        {rewardsUrl()
          ? "Epoch files come from this app's published folder and from the rewards URL it is configured with."
          : "Epoch files come from this app's published folder."}{" "}
        Hunch's own maker bot is never paid rewards.
      </p>
    </div>
  );
}
