// The collateral token, only its transfers into and out of the vault: they add up to the vault's USDC
// balance, which ProtocolStats compares with what the vault owes (the solvency margin).
import { type Address, indexer } from "envio";
import { addr, networkOf } from "../lib/network.js";
import { Unit } from "../lib/store.js";

indexer.onEvent(
  {
    contract: "Usdc",
    event: "Transfer",
    where: ({ chain }) => {
      const vault = networkOf(chain.id).contracts.vault as Address | null;
      if (!vault) return false;
      return { params: [{ from: vault }, { to: vault }] };
    },
  },
  async ({ event, context }) => {
    const u = await Unit.start(context, event, "VaultEvent");
    if (!u) return;
    const vault = networkOf(u.m.chainId).contracts.vault;
    const from = addr(event.params.from);
    const to = addr(event.params.to);
    const { value } = event.params;
    const into = to === vault;
    const out = from === vault;
    if (into === out) return; // neither (filtered out upstream) or a self-transfer: no change
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
