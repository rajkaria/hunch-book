// The collateral token, only its transfers into and out of every stack's vault: they add up to the
// vaults' USDC balance, which ProtocolStats compares with what the vaults owe (the solvency margin).
import { type Address, indexer } from "envio";
import { addr, isVault, vaultsOf } from "../lib/network.js";
import { Unit } from "../lib/store.js";

indexer.onEvent(
  {
    contract: "Usdc",
    event: "Transfer",
    where: ({ chain }) => {
      const vaults = vaultsOf(chain.id) as Address[];
      if (vaults.length === 0) return false;
      return { params: [{ from: vaults }, { to: vaults }] };
    },
  },
  async ({ event, context }) => {
    const u = await Unit.start(context, event, "VaultEvent");
    if (!u) return;
    const from = addr(event.params.from);
    const to = addr(event.params.to);
    const { value } = event.params;
    const into = isVault(u.m.chainId, to);
    const out = isVault(u.m.chainId, from);
    // Neither (filtered out upstream), or between vaults: the vaults' total does not change.
    if (into === out) return;
    u.create("VaultEvent", {
      id: u.m.id,
      kind: into ? "UsdcIn" : "UsdcOut",
      market_id: undefined,
      account: into ? from : to,
      amount: value,
      fee: 0n,
      block: u.m.block,
      timestamp: u.m.timestamp,
      tx: u.m.tx,
    });
    const s = await u.stats();
    const d = await u.daily();
    if (into) {
      s.vaultUsdcIn += value;
      d.vaultUsdcIn += value;
    } else {
      s.vaultUsdcOut += value;
      d.vaultUsdcOut += value;
    }
    u.flush();
  },
);
