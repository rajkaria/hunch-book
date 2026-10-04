import { addressUrl, blockUrl } from "@hunch-book/shared";
import type { LandingRead, LandingSnapshot } from "@/lib/chain/landing";
import { appDeployment, appNetwork, appNetworkLabel, factoryOf } from "@/lib/config";
import { TESTNET_MONEY } from "@/lib/copy";
import { formatInt, formatUsdc } from "@/lib/format";
import { LiveDot, Stat } from "../ui";
import { ContractLinks } from "./Hero";
import s from "./landing.module.css";

const plural = (n: number, one: string, many: string): string => `${formatInt(n)} ${n === 1 ? one : many}`;

/** What the vault figure includes: test money on testnet, and our own seed stakes when there are any. */
export function vaultHint(data: Pick<LandingSnapshot, "vault" | "stats">): string | undefined {
  if (!data.vault) return "could not read the vault just now";
  const ours = data.stats !== null && data.stats.createdByUs > 0;
  if (appNetwork === "monad-testnet")
    return ours ? "test USDC, including stakes from our own wallets" : "test USDC";
  return ours ? "including stakes from our own wallets" : undefined;
}

/** How many graduated books were seeded by us, and whether the count covers only the newest markets. */
export function graduatedHint(data: Pick<LandingSnapshot, "stats" | "marketCount">): string {
  const { stats } = data;
  if (!stats) return "could not read the markets just now";
  const scope = stats.listed < data.marketCount ? `, of the newest ${formatInt(stats.listed)}` : "";
  return stats.graduatedByUs > 0
    ? `${plural(stats.graduatedByUs, "was", "were")} seeded by us${scope}`
    : `each with its own order book${scope}`;
}

function Tiles({ data }: { data: LandingSnapshot }) {
  const factory = factoryOf(appDeployment);
  const vault = appDeployment.hunchBook.vault;
  const { stats } = data;
  return (
    <div className={s.tiles}>
      <div className={s.tile}>
        <Stat
          size="lg"
          label={data.marketCount === 1 ? "Market created" : "Markets created"}
          value={formatInt(data.marketCount)}
          hint={stats ? `${formatInt(stats.open)} open now` : undefined}
          source={
            factory
              ? { href: addressUrl(appDeployment, factory), label: "factory.marketCount", external: true }
              : undefined
          }
        />
      </div>
      <div className={s.tile}>
        <Stat
          size="lg"
          label="USDC in the vault"
          value={data.vault ? formatUsdc(data.vault.balance) : "n/a"}
          tone={data.vault ? undefined : "muted"}
          hint={vaultHint(data)}
          source={
            vault
              ? { href: addressUrl(appDeployment, vault), label: "USDC.balanceOf(vault)", external: true }
              : undefined
          }
        />
      </div>
      <div className={s.tile}>
        <Stat
          size="lg"
          label="Graduated to Kuru"
          value={stats ? formatInt(stats.graduated) : "n/a"}
          tone={stats ? undefined : "muted"}
          hint={graduatedHint(data)}
          source={{ href: "/markets?phase=trading", label: "see the books" }}
        />
      </div>
      <div className={s.tile}>
        <Stat
          size="lg"
          label="Trades"
          value="Planned"
          tone="muted"
          hint="counted by the indexer, with our maker's fills apart"
          source={{ href: "/proof", label: "how we will count" }}
        />
      </div>
      <div className={s.tile}>
        <Stat
          size="lg"
          label="Block time"
          value={data.msPerBlock !== null ? `${(data.msPerBlock / 1000).toFixed(2)}s` : "n/a"}
          tone={data.msPerBlock !== null ? undefined : "muted"}
          hint="average over the last 10,000 blocks"
          source={
            data.block !== null
              ? {
                  href: blockUrl(appDeployment, data.block),
                  label: `block ${formatInt(data.block)}`,
                  external: true,
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}

/** The live numbers strip: every figure is read from the chain on each refresh and links to its source. */
export function LiveNumbers({ live }: { live: LandingRead }) {
  const testnet = appNetwork === "monad-testnet";
  return (
    <section className={s.liveSection} aria-labelledby="live-title">
      <div className={s.wrap}>
        <div className={s.liveCard}>
          <div className={s.liveHead}>
            <h2 className={s.liveTitle} id="live-title">
              <LiveDot tone={live.status === "ok" ? "accent" : "muted"} />
              {live.status === "not-deployed" ? "Not deployed yet" : `Live from ${appNetworkLabel}`}
            </h2>
            {live.status === "ok" && live.data.block !== null ? (
              <p className={s.liveMeta}>
                Read at block {formatInt(live.data.block)}. Refreshes about every 30 seconds.
              </p>
            ) : (
              <p className={s.liveMeta}>Read from the contracts, about every 30 seconds.</p>
            )}
          </div>
          {live.status === "ok" ? (
            <Tiles data={live.data} />
          ) : (
            <div className={s.liveEmpty}>
              <p className={s.liveEmptyTitle}>
                {live.status === "not-deployed"
                  ? `The contracts are not deployed on ${appNetworkLabel} yet.`
                  : `Could not reach ${appNetworkLabel} just now.`}
              </p>
              <p className="muted">
                {live.status === "not-deployed"
                  ? "This panel fills in from the chain once they are."
                  : "Nothing here is cached or estimated, so the figures stay hidden until the next read succeeds."}
              </p>
            </div>
          )}
          <div className={s.liveFoot}>
            <ContractLinks />
            {testnet ? <p className={s.testnetNote}>{TESTNET_MONEY}</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
