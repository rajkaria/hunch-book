// TemplateTimelock (docs/PERIPHERY.md): every queued factory change with its calldata decoded, so the
// public review of a new template or limit is visible from the moment it is queued; and the actions
// that take effect at once (pauses, accepting the guardian role).
import { type Enum, indexer } from "envio";
import { addr, scopedId } from "../lib/network.js";
import { Unit } from "../lib/store.js";
import { decodeTimelockCall, TIMELOCK_GRACE_PERIOD_SECONDS } from "../lib/timelock.js";

indexer.onEvent({ contract: "TemplateTimelock", event: "OperationQueued" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const { nonce, data, readyAt } = event.params;
  // Two stacks' timelocks can queue the same call at the same nonce, so the same operation id.
  const id = scopedId(u.m.chainId, u.m.src, event.params.id.toLowerCase());
  if (await u.exists("TimelockOperation", id)) return;
  const call = decodeTimelockCall(data);
  u.create("TimelockOperation", {
    id,
    timelock: u.m.src,
    nonce,
    selector: event.params.selector.toLowerCase(),
    kind: call.kind,
    data,
    summary: call.summary,
    templateId: call.templateId,
    resolver: call.resolver,
    minPool: call.minPool,
    minStakers: call.minStakers,
    minChanceBps: call.minChanceBps,
    maxChanceBps: call.maxChanceBps,
    poolCap: call.poolCap,
    walletCap: call.walletCap,
    minStake: call.minStake,
    creatorMinStake: call.creatorMinStake,
    collateralCap: call.collateralCap,
    pendingGuardian: call.pendingGuardian,
    readyAt,
    expiresAt: readyAt + TIMELOCK_GRACE_PERIOD_SECONDS,
    status: "Queued",
    proposer: u.m.from,
    queuedAt: u.m.timestamp,
    queuedAtBlock: u.m.block,
    queueTx: u.m.tx,
    executor: undefined,
    executorIsOurs: undefined,
    executedAt: undefined,
    executeTx: undefined,
    cancelledAt: undefined,
    cancelTx: undefined,
  });
  const s = await u.stats();
  s.timelockQueued += 1;
  s.timelockPending += 1;
  u.flush();
});

/** The queued operation an event ends, or undefined if it is unknown or already ended (seen already). */
async function queuedOperation(u: Unit, id: string) {
  const op = await u.find("TimelockOperation", scopedId(u.m.chainId, u.m.src, id.toLowerCase()));
  if (!op) {
    u.log.warn("event for a timelock operation the indexer has not seen", { id, event: u.m.id });
    return undefined;
  }
  return op.status === "Queued" ? op : undefined;
}

indexer.onEvent({ contract: "TemplateTimelock", event: "OperationExecuted" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const op = await queuedOperation(u, event.params.id);
  if (!op) return;
  const executor = addr(event.params.executor);
  op.status = "Executed";
  op.executor = executor;
  op.executorIsOurs = await u.isOurs(executor);
  op.executedAt = u.m.timestamp;
  op.executeTx = u.m.tx;
  const s = await u.stats();
  s.timelockExecuted += 1;
  s.timelockPending -= 1;
  u.flush();
});

indexer.onEvent({ contract: "TemplateTimelock", event: "OperationCancelled" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const op = await queuedOperation(u, event.params.id);
  if (!op) return;
  op.status = "Cancelled";
  op.cancelledAt = u.m.timestamp;
  op.cancelTx = u.m.tx;
  const s = await u.stats();
  s.timelockCancelled += 1;
  s.timelockPending -= 1;
  u.flush();
});

async function action(
  context: Parameters<typeof Unit.start>[0],
  event: Parameters<typeof Unit.start>[1],
  kind: Enum<"TimelockActionKind">,
  paused: boolean | undefined,
): Promise<void> {
  const u = await Unit.start(context, event, "TimelockAction");
  if (!u) return;
  u.create("TimelockAction", {
    id: u.m.id,
    timelock: u.m.src,
    kind,
    paused,
    sender: u.m.from,
    senderIsOurs: await u.isOurs(u.m.from),
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  u.flush();
}

indexer.onEvent({ contract: "TemplateTimelock", event: "CreationPauseSet" }, async ({ event, context }) => {
  await action(context, event, "CreationPause", event.params.paused);
});

indexer.onEvent({ contract: "TemplateTimelock", event: "GraduationPauseSet" }, async ({ event, context }) => {
  await action(context, event, "GraduationPause", event.params.paused);
});

indexer.onEvent({ contract: "TemplateTimelock", event: "GuardianAccepted" }, async ({ event, context }) => {
  await action(context, event, "GuardianAccepted", undefined);
});
