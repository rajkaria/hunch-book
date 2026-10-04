"use client";

import { addressUrl, CREATOR_SHARE_BPS, collateralVaultAbi } from "@hunch-book/shared";
import Link from "next/link";
import { type Abi, type Address, isAddressEqual } from "viem";
import { appDeployment, appNetworkLabel } from "@/lib/config";
import { creatorKeys, useCreator, useCreatorFees } from "@/lib/creator/hooks";
import type { CreatorData } from "@/lib/creator/read";
import { formatBpsPercent, formatInt, formatUsdc, formatUtc, shortAddress } from "@/lib/format";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, useTxRunner } from "@/lib/wallet/useTxRunner";
import { INDEXER_DOCS_URL, QUERIES_URL, SourceTag } from "../indexer/SourceTag";
import { TxList } from "../market/TxList";
import { ErrorState, LoadingRows } from "../states";
import { Badge, Button, Notice, Panel, Stat, TxLink } from "../ui";
import { ConnectButton } from "../wallet/ConnectButton";
import s from "./creator.module.css";

const SHARE = formatBpsPercent(CREATOR_SHARE_BPS);

function Withdraw({ creator, owed }: { creator: Address; owed: bigint | null }) {
  const wallet = useAppChain();
  const tx = useTxRunner([creatorKeys.fees(creator), creatorKeys.page(creator)]);
  const vault = appDeployment.hunchBook.vault;
  const isCreator = Boolean(wallet.address && isAddressEqual(wallet.address, creator));
  if (!isCreator || !vault) return null;
  const send = () => {
    if (!wallet.address) return;
    void tx.run(
      "Withdraw creator fees",
      {
        address: vault,
        abi: collateralVaultAbi as Abi,
        functionName: "withdrawCreatorFees",
        args: [wallet.address],
      },
      wallet.address,
    );
  };
  return (
    <div className={s.withdraw}>
      <div>
        <p className={s.withdrawTitle}>This is your creator page</p>
        <p className={s.note}>
          {owed && owed > 0n
            ? `Withdraw sends ${formatUsdc(owed)} USDC from the vault to your wallet.`
            : "Nothing to withdraw right now. Fees arrive as your markets' winners redeem and pools pay out."}
        </p>
      </div>
      {wallet.wrongNetwork ? (
        <span className={s.note}>
          Switch your wallet to {appNetworkLabel} to withdraw. <ConnectButton />
        </span>
      ) : (
        <Button variant="primary" disabled={!owed || owed === 0n || tx.busy} loading={tx.busy} onClick={send}>
          {tx.busy ? stageText(tx.stage) : "Withdraw my fees"}
        </Button>
      )}
      {tx.error ? (
        <p className={s.error} role="alert">
          {tx.error}
        </p>
      ) : null}
      <TxList txs={tx.txs} />
    </div>
  );
}

function Earnings({ creator, data }: { creator: Address; data: CreatorData | undefined }) {
  const fees = useCreatorFees(creator);
  const vault = appDeployment.hunchBook.vault;
  const owed = fees.data ?? null;
  return (
    <Panel title="Earnings" labelledBy="creator-earnings">
      <div className={s.grid}>
        <Stat
          label="Fees to withdraw"
          value={fees.isPending ? "..." : owed === null ? "n/a" : formatUsdc(owed)}
          size="lg"
          tone="accent"
          hint="USDC, live from the vault"
          source={
            vault
              ? {
                  href: addressUrl(appDeployment, vault),
                  label: "vault.creatorFees(creator)",
                  external: true,
                }
              : undefined
          }
        />
        <Stat
          label="Earned in total"
          value={
            data?.earned === null || data?.earned === undefined
              ? "needs the indexer"
              : formatUsdc(data.earned)
          }
          hint={data?.earned === null ? undefined : "USDC"}
          source={
            data?.earned === null
              ? undefined
              : { href: QUERIES_URL, label: "indexer: Creator.feesAccrued", external: true }
          }
        />
        <Stat
          label="Withdrawn"
          value={
            data?.withdrawn === null || data?.withdrawn === undefined
              ? "needs the indexer"
              : formatUsdc(data.withdrawn)
          }
          hint={data?.withdrawn === null ? undefined : "USDC"}
          source={
            data?.withdrawn === null
              ? undefined
              : { href: QUERIES_URL, label: "indexer: Creator.feesWithdrawn", external: true }
          }
        />
      </div>
      <p className={s.note}>
        A market's creator earns {SHARE} of Hunch Book's fee on it: the 2% taken from winnings, charged when
        winners redeem or a pool pays out. The vault keeps it until the creator withdraws.
      </p>
      <Withdraw creator={creator} owed={owed} />
    </Panel>
  );
}

function Withdrawals({ data }: { data: CreatorData }) {
  if (data.withdrawals === null) {
    return (
      <Panel title="Withdrawals" labelledBy="creator-withdrawals">
        <p className={s.note}>
          The list of past withdrawals needs the indexer.{" "}
          <a href={INDEXER_DOCS_URL} target="_blank" rel="noreferrer">
            About the indexer
          </a>
          .
        </p>
      </Panel>
    );
  }
  return (
    <Panel title="Withdrawals" labelledBy="creator-withdrawals">
      {data.withdrawals.length === 0 ? (
        <p className={s.note}>No withdrawals yet.</p>
      ) : (
        <div className={s.scroll}>
          <table className={s.table}>
            <caption className="visually-hidden">Creator fee withdrawals</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col" className={s.num}>
                  USDC
                </th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {data.withdrawals.map((w) => (
                <tr key={w.tx}>
                  <td>{formatUtc(w.time)}</td>
                  <td className={`${s.num} mono`}>{formatUsdc(w.amount)}</td>
                  <td>
                    <TxLink hash={w.tx} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Markets({ data }: { data: CreatorData }) {
  const indexed = data.scanned === null;
  return (
    <Panel
      title="Markets created"
      labelledBy="creator-markets"
      aside={<Badge tone="muted">{formatInt(data.markets.length)}</Badge>}
    >
      {data.scanned && data.scanned.covered < data.scanned.total ? (
        <p className={s.note}>
          From the chain, this lists the creator's markets among the newest {formatInt(data.scanned.covered)}{" "}
          of {formatInt(data.scanned.total)}. The indexer lists all of them.
        </p>
      ) : null}
      {data.markets.length === 0 ? (
        <p className={s.note}>
          This address has not created a market{data.scanned ? " among those read" : ""}.
        </p>
      ) : (
        <div className={s.scroll}>
          <table className={s.table}>
            <caption className="visually-hidden">Markets this address created</caption>
            <thead>
              <tr>
                <th scope="col">Market</th>
                <th scope="col">Stage</th>
                <th scope="col" className={s.num}>
                  Pool
                </th>
                <th scope="col" className={s.num}>
                  Stakers
                </th>
                <th scope="col" className={s.num}>
                  Book volume
                </th>
                <th scope="col" className={s.num}>
                  Earned
                </th>
              </tr>
            </thead>
            <tbody>
              {data.markets.map((m) => (
                <tr key={m.market}>
                  <td className={s.market}>
                    <Link href={`/m/${m.market}`} title={m.question ?? m.market}>
                      {m.number !== null ? `#${m.number}` : shortAddress(m.market)}
                      {m.question ? <span className={s.question}> {m.question}</span> : null}
                    </Link>
                  </td>
                  <td>{m.stage}</td>
                  <td className={`${s.num} mono`}>{formatUsdc(m.pool)}</td>
                  <td className={`${s.num} mono`}>{formatInt(m.stakers)}</td>
                  <td className={`${s.num} mono`}>
                    {m.volume === null ? <span className={s.subtle}>indexer</span> : formatUsdc(m.volume)}
                  </td>
                  <td className={`${s.num} mono`}>
                    {m.earned === null ? <span className={s.subtle}>indexer</span> : formatUsdc(m.earned)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!indexed ? (
        <p className={s.note}>
          Book volume and earnings per market need the indexer. Pool sizes are read live.
        </p>
      ) : null}
    </Panel>
  );
}

/** A creator's page: markets, earnings, withdrawals, and the withdraw button for the creator. */
export function CreatorView({ creator }: { creator: Address }) {
  const query = useCreator(creator);
  if (query.isPending) return <LoadingRows rows={2} label="Loading the creator's markets" />;
  if (query.isError) {
    return <ErrorState title="Could not load this creator" onRetry={() => void query.refetch()} />;
  }
  const { data, source, fallback, indexedBlock } = query.data;
  return (
    <div className={s.stack}>
      <div className={s.sourceRow}>
        <SourceTag source={source} fallback={fallback} indexedBlock={indexedBlock} />
        <a className={s.subtle} href={addressUrl(appDeployment, creator)} target="_blank" rel="noreferrer">
          {creator} on the explorer ↗
        </a>
      </div>
      {data.isOurs ? (
        <Notice tone="warn" title="One of Hunch Book's own wallets">
          <p>Markets created by our wallets are labelled ours wherever they are counted.</p>
        </Notice>
      ) : null}
      <Earnings creator={creator} data={data} />
      <Markets data={data} />
      <Withdrawals data={data} />
    </div>
  );
}
