import { type Deployment, type GraduationRule, hunchBookFactoryAbi, TemplateId } from "@hunch-book/shared";
import type { Address } from "viem";
import type { MarketView } from "../market/types";
import type { ReadClient } from "./client";
import { measureMsPerBlock, readChainHead, readMarketViews } from "./reads";

// What the landing page shows from the chain. Every field is either read now or absent:
// a failed read hides that line, it never falls back to a made-up number.

export interface LandingSnapshot {
  marketCount: number;
  /** The newest market from the factory, or null when there are none. */
  newest: MarketView | null;
  /** The graduation rule new Perpl funding markets get, from factory.templateOf. */
  rule: GraduationRule | null;
  /** Average block time over the last 10,000 blocks, in milliseconds. */
  msPerBlock: number | null;
  /** The block the snapshot was read at. */
  block: bigint | null;
}

export type LandingRead =
  | { status: "not-deployed" }
  | { status: "error" }
  | { status: "ok"; data: LandingSnapshot };

/** Addresses that belong to Hunch Book itself: its guardian (the deployer), fee recipient, maker and keeper. */
export function ourAddresses(deployment: Deployment): Address[] {
  return [
    deployment.hunchBook.guardian,
    deployment.hunchBook.feeRecipient,
    deployment.wallets.maker,
    deployment.wallets.keeper,
  ].filter((a): a is Address => Boolean(a));
}

/** True when a market was created by one of Hunch Book's own wallets. */
export function isSeededByUs(deployment: Deployment, creator: Address): boolean {
  const c = creator.toLowerCase();
  return ourAddresses(deployment).some((a) => a.toLowerCase() === c);
}

const settled = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

/** Reads the landing page's live panel. Never throws. */
export async function readLandingSnapshot(
  client: ReadClient,
  deployment: Deployment,
  timeoutMs = 6_000,
): Promise<LandingRead> {
  const factory = deployment.hunchBook.factory;
  if (!factory) return { status: "not-deployed" };

  const work = (async (): Promise<LandingRead> => {
    const count = Number(
      await client.readContract({ address: factory, abi: hunchBookFactoryAbi, functionName: "marketCount" }),
    );
    const [newest, template, pace] = await Promise.allSettled([
      (async () => {
        if (count === 0) return null;
        const address = await client.readContract({
          address: factory,
          abi: hunchBookFactoryAbi,
          functionName: "marketAt",
          args: [BigInt(count - 1)],
        });
        const [view] = await readMarketViews(client, [address]);
        return view ?? null;
      })(),
      client.readContract({
        address: factory,
        abi: hunchBookFactoryAbi,
        functionName: "templateOf",
        args: [TemplateId.PerplFunding],
      }),
      (async () => {
        const head = await readChainHead(client);
        return { block: head.blockNumber, ms: await measureMsPerBlock(client, head.blockNumber) };
      })(),
    ]);
    const tmpl = settled(template);
    const rule: GraduationRule | null =
      tmpl && BigInt(tmpl.rule.minPool) > 0n
        ? {
            minPool: BigInt(tmpl.rule.minPool),
            minStakers: Number(tmpl.rule.minStakers),
            minChanceBps: Number(tmpl.rule.minChanceBps),
            maxChanceBps: Number(tmpl.rule.maxChanceBps),
          }
        : null;
    return {
      status: "ok",
      data: {
        marketCount: count,
        newest: settled(newest),
        rule,
        msPerBlock: settled(pace)?.ms ?? null,
        block: settled(pace)?.block ?? null,
      },
    };
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<LandingRead>((resolve) => {
    timer = setTimeout(() => resolve({ status: "error" }), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return { status: "error" };
  } finally {
    clearTimeout(timer);
  }
}
