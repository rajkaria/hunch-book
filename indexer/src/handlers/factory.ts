// HunchBookFactory: templates and market creation.
import { indexer } from "envio";
import { addr, networkOf } from "../lib/network.js";
import { marketTerms, parlayDetails, snapshotId } from "../lib/params.js";
import { emptyMarket, Unit } from "../lib/store.js";

indexer.onEvent({ contract: "HunchBookFactory", event: "TemplateAdded" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const id = event.params.templateId.toString();
  if (await u.exists("Template", id)) return;
  const { rule } = event.params;
  u.create("Template", {
    id,
    templateId: event.params.templateId,
    resolver: addr(event.params.resolver),
    minPool: rule.minPool,
    minStakers: rule.minStakers,
    minChanceBps: rule.minChanceBps,
    maxChanceBps: rule.maxChanceBps,
    marketCount: 0,
    addedAtBlock: u.m.block,
    addedAt: u.m.timestamp,
    addedTx: u.m.tx,
  });
  u.flush();
});

// The vault's MarketRegistered also registers the market (it comes first in the creation transaction,
// before the creator's first Staked). Registering twice is harmless.
indexer.contractRegister(
  { contract: "HunchBookFactory", event: "MarketCreated" },
  async ({ event, context }) => {
    context.chain.Market.add(event.params.market);
  },
);

indexer.onEvent({ contract: "HunchBookFactory", event: "MarketCreated" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const { market: marketAddress, templateId, key, creator, params } = event.params;
  // MarketRegistered created the skeleton earlier in this transaction; build one if it is somehow missing.
  const market = await u.load("Market", addr(marketAddress), () =>
    emptyMarket(marketAddress, { yes: "", no: "", creator }, u.m),
  );
  if (market.number !== 0) return; // already processed

  const s = await u.stats();
  s.marketsCreated += 1;
  s.marketsPool += 1;
  (await u.daily()).marketsCreated += 1;

  Object.assign(market, marketTerms(templateId, params, networkOf(u.m.chainId)));
  market.number = s.marketsCreated;
  market.template_id = templateId.toString();
  market.templateId = templateId;
  market.key = key;
  market.params = params;

  const template = await u.find("Template", templateId.toString());
  if (template) template.marketCount += 1;
  // Template 7: link the snapshot the market answers from. It exists once someone takes it.
  if (market.snapshotKey) {
    const resolver = template?.resolver ?? networkOf(u.m.chainId).resolvers.snapshot;
    if (resolver) market.snapshot_id = snapshotId(resolver, market.snapshotKey);
  }
  // Template 6: name the legs by their market numbers, and take the deadline from theirs.
  if (market.legs && market.closeAt !== undefined) {
    const legs = [];
    for (const id of market.legs) {
      const leg = await u.market(id);
      legs.push({ id, number: leg?.number, settleDeadline: leg?.settleDeadline });
    }
    Object.assign(market, parlayDetails(legs, market.closeAt));
  }
  (await u.creator(creator)).marketCount += 1;
  (await u.wallet(creator)).marketsCreated += 1;
  u.flush();
});
