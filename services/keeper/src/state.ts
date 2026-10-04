import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Address, getAddress, isAddress } from "viem";
import { log, toJson } from "./log.js";

// What the keeper remembers between restarts, in one JSON file (KEEPER_STATE_FILE). Everything here
// can be rebuilt from the chain; the file only saves the log scans from starting over. It holds no
// secret and no user funds depend on it.

export interface MarketState {
  /** Block of the factory's MarketCreated event for this market. */
  createdBlock?: number;
  /** Next block the Staked-log scan reads. */
  stakerCursor?: number;
  /** Every address seen in a Staked event, in first-seen order. */
  stakers: Address[];
  /**
   * A block at which the market was already past staking (not a Pool). No Staked event can come
   * after it, so once the scan passes it the staker list is complete.
   */
  stakingClosedAt?: number;
  /** Unix seconds of the last book request sent to Kuru for this market (mainnet). */
  bookRequestedAt?: number;
}

/** Holders who opted in to auto-redeem, from the AutoRedeemer's OptInSet events. */
export interface AutoRedeemState {
  /** The AutoRedeemer these holders belong to (a new one starts over). */
  redeemer: Address;
  /** Next block the OptInSet scan reads. */
  cursor?: number;
  /** Holders whose latest OptInSet was true, in first-seen order. */
  optedIn: Address[];
}

export interface KeeperState {
  version: 1;
  network: string;
  factory: Address;
  /** Next block the MarketCreated scan reads. */
  factoryCursor?: number;
  markets: Record<Address, MarketState>;
  autoRedeem?: AutoRedeemState;
}

export function emptyState(network: string, factory: Address): KeeperState {
  return { version: 1, network, factory, markets: {} };
}

function isState(value: unknown): value is KeeperState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<KeeperState>;
  return v.version === 1 && typeof v.network === "string" && typeof v.factory === "string" && !!v.markets;
}

/** Parses a saved state; anything unreadable, or for another network or factory, starts fresh. */
export function parseState(text: string, network: string, factory: Address): KeeperState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyState(network, factory);
  }
  if (!isState(parsed) || parsed.network !== network || !isAddress(parsed.factory)) {
    return emptyState(network, factory);
  }
  if (getAddress(parsed.factory) !== getAddress(factory)) return emptyState(network, factory);
  const markets: Record<Address, MarketState> = {};
  for (const [address, m] of Object.entries(parsed.markets)) {
    if (!isAddress(address) || !m || typeof m !== "object") continue;
    markets[getAddress(address)] = {
      ...m,
      stakers: Array.isArray(m.stakers)
        ? m.stakers.filter((s) => isAddress(s)).map((s) => getAddress(s))
        : [],
    };
  }
  const out: KeeperState = { ...parsed, factory: getAddress(parsed.factory), markets };
  const ar = parsed.autoRedeem;
  if (ar && typeof ar === "object" && isAddress(ar.redeemer) && Array.isArray(ar.optedIn)) {
    out.autoRedeem = {
      redeemer: getAddress(ar.redeemer),
      cursor: typeof ar.cursor === "number" ? ar.cursor : undefined,
      optedIn: ar.optedIn.filter((s) => isAddress(s)).map((s) => getAddress(s)),
    };
  } else {
    delete out.autoRedeem;
  }
  return out;
}

export class StateStore {
  private state: KeeperState;
  private dirty = false;

  constructor(
    private readonly file: string,
    network: string,
    factory: Address,
  ) {
    this.state = existsSync(file)
      ? parseState(readFileSync(file, "utf8"), network, factory)
      : emptyState(network, factory);
  }

  get factoryCursor(): number | undefined {
    return this.state.factoryCursor;
  }

  set factoryCursor(block: number) {
    this.state.factoryCursor = block;
    this.dirty = true;
  }

  market(address: Address): MarketState {
    const key = getAddress(address);
    let m = this.state.markets[key];
    if (!m) {
      m = { stakers: [] };
      this.state.markets[key] = m;
    }
    return m;
  }

  /** Changes one market's record and marks the file for saving. */
  update(address: Address, patch: (m: MarketState) => void): void {
    patch(this.market(address));
    this.dirty = true;
  }

  /** Adds stakers not seen before; returns how many were new. */
  addStakers(address: Address, users: Address[]): number {
    const m = this.market(address);
    const seen = new Set(m.stakers);
    let added = 0;
    for (const user of users) {
      const u = getAddress(user);
      if (!seen.has(u)) {
        seen.add(u);
        m.stakers.push(u);
        added++;
      }
    }
    if (added > 0) this.dirty = true;
    return added;
  }

  /** The auto-redeem record for `redeemer`; a different redeemer than the saved one starts over. */
  autoRedeem(redeemer: Address): AutoRedeemState {
    const key = getAddress(redeemer);
    if (!this.state.autoRedeem || this.state.autoRedeem.redeemer !== key) {
      this.state.autoRedeem = { redeemer: key, optedIn: [] };
      this.dirty = true;
    }
    return this.state.autoRedeem;
  }

  updateAutoRedeem(redeemer: Address, patch: (s: AutoRedeemState) => void): void {
    patch(this.autoRedeem(redeemer));
    this.dirty = true;
  }

  snapshot(): KeeperState {
    return this.state;
  }

  /** Writes the file if anything changed (temp file, then rename, so a crash never leaves half a file). */
  save(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${toJson(this.state, 2)}\n`);
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (error) {
      log("state-write-failed", { file: this.file, error: String(error) }, "warn");
    }
  }
}
