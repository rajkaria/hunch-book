// TemplateTimelock: queued factory changes with their calldata decoded for public review, executions,
// cancellations, and the actions that take effect at once.
import { encodeFunctionData, getAbiItem } from "viem";
import { describe, expect, it } from "vitest";
import { hunchBookFactoryAbi } from "../../packages/shared/src/abis/generated.js";
import { decodeTimelockCall, TIMELOCK_GRACE_PERIOD_SECONDS, timelockCallsAbi } from "../src/lib/timelock.js";
import { ADDR, ALICE, afterPeripheryDeploy, Protocol, USDC } from "./helpers.js";

const RESOLVER = "0x00000000000000000000000000000000000000c8";
const NEW_GUARDIAN = "0x00000000000000000000000000000000000000d9";
const READY = 1_791_300_000n;

const addTemplate = encodeFunctionData({
  abi: hunchBookFactoryAbi,
  functionName: "addTemplate",
  args: [8, RESOLVER, { minPool: USDC(500), minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 }],
});
const setCaps = encodeFunctionData({
  abi: hunchBookFactoryAbi,
  functionName: "setCaps",
  args: [{ poolCap: USDC(10_000), walletCap: USDC(1_000), minStake: USDC(1), creatorMinStake: USDC(20) }],
});
const setCollateralCap = encodeFunctionData({
  abi: hunchBookFactoryAbi,
  functionName: "setCollateralCap",
  args: [USDC(250_000)],
});
const transferGuardian = encodeFunctionData({
  abi: hunchBookFactoryAbi,
  functionName: "transferGuardian",
  args: [NEW_GUARDIAN],
});

describe("timelock calldata", () => {
  it("uses the factory's own signatures for the four calls the timelock can queue", () => {
    for (const fn of timelockCallsAbi) {
      const factoryFn = getAbiItem({ abi: hunchBookFactoryAbi, name: fn.name });
      expect(JSON.stringify(fn.inputs)).toBe(
        JSON.stringify(
          (factoryFn as { inputs: unknown[] }).inputs.map((i) => strip(i as Record<string, unknown>)),
        ),
      );
    }
  });

  it("decodes each call into its arguments and a sentence", () => {
    expect(decodeTimelockCall(addTemplate)).toEqual({
      kind: "AddTemplate",
      summary: `Add template 8 with resolver ${RESOLVER}. A market graduates with at least 500 USDC staked by at least 10 wallets, at a chance from 3% to 97%.`,
      templateId: 8n,
      resolver: RESOLVER,
      minPool: USDC(500),
      minStakers: 10n,
      minChanceBps: 300n,
      maxChanceBps: 9_700n,
    });
    expect(decodeTimelockCall(setCaps)).toMatchObject({
      kind: "SetCaps",
      summary:
        "Set the caps for new markets: a pool of at most 10,000 USDC, at most 1,000 USDC per wallet, stakes of at least 1 USDC, and a creator's first stake of at least 20 USDC.",
      poolCap: USDC(10_000),
      creatorMinStake: USDC(20),
    });
    expect(decodeTimelockCall(setCollateralCap)).toEqual({
      kind: "SetCollateralCap",
      summary: "Set the vault's collateral cap to 250,000 USDC.",
      collateralCap: USDC(250_000),
    });
    expect(decodeTimelockCall(transferGuardian)).toMatchObject({
      kind: "TransferGuardian",
      pendingGuardian: NEW_GUARDIAN,
    });
    expect(decodeTimelockCall("0xdeadbeef00")).toEqual({
      kind: "Unknown",
      summary: "A call with selector 0xdeadbeef that the indexer does not decode.",
    });
  });
});

describe("timelock operations", () => {
  it("are public from the moment they are queued, until executed or cancelled", async () => {
    const p = new Protocol();
    afterPeripheryDeploy(p, ADDR.guardian);
    const ids = [addTemplate, setCaps, setCollateralCap, transferGuardian].map((data, i) =>
      p.queueOperation({ data, nonce: BigInt(i), readyAt: READY }),
    );
    p.s.next({ seconds: 2 * 86_400, from: ALICE });
    p.executeOperation({ id: ids[0] as string, nonce: 0n, executor: ALICE });
    p.s.next({ from: ADDR.guardian });
    p.cancelOperation(ids[3] as string);
    p.s.emit("TemplateTimelock", "CreationPauseSet", { paused: true }, ADDR.timelock);
    p.s.emit("TemplateTimelock", "GraduationPauseSet", { paused: false }, ADDR.timelock);
    p.s.next({ from: ALICE });
    p.s.emit("TemplateTimelock", "GuardianAccepted", {}, ADDR.timelock);
    // A second end for an operation that already ended is ignored.
    p.executeOperation({ id: ids[3] as string, nonce: 3n, executor: ALICE });
    await p.run();

    const added = await p.indexer.TimelockOperation.getOrThrow(ids[0] as string);
    expect(added).toMatchObject({
      timelock: ADDR.timelock,
      nonce: 0n,
      selector: addTemplate.slice(0, 10),
      kind: "AddTemplate",
      data: addTemplate,
      templateId: 8n,
      resolver: RESOLVER,
      readyAt: READY,
      expiresAt: READY + TIMELOCK_GRACE_PERIOD_SECONDS,
      status: "Executed",
      proposer: ADDR.guardian,
      executor: ALICE,
      executorIsOurs: false,
    });
    expect((await p.indexer.TimelockOperation.getOrThrow(ids[1] as string)).status).toBe("Queued");
    expect(await p.indexer.TimelockOperation.getOrThrow(ids[3] as string)).toMatchObject({
      status: "Cancelled",
      kind: "TransferGuardian",
      pendingGuardian: NEW_GUARDIAN,
    });
    const actions = await p.indexer.TimelockAction.getAll();
    expect(actions.map((a) => [a.kind, a.paused, a.senderIsOurs])).toEqual([
      ["CreationPause", true, true],
      ["GraduationPause", false, true],
      ["GuardianAccepted", undefined, false],
    ]);
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      timelockQueued: 4,
      timelockExecuted: 1,
      timelockCancelled: 1,
      timelockPending: 2,
    });
  });
});

/** An ABI parameter without the internalType field Foundry adds. */
function strip(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { name: p.name, type: p.type };
  if (Array.isArray(p.components)) out.components = p.components.map((c) => strip(c));
  return out;
}
