import type { LandingRead } from "@/lib/chain/landing";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { LiveNumbers } from "./LiveNumbers";
import { Audiences, Closing, Faq, Safety, WhyMonad } from "./Sections";

export { ContractLinks, Hero, HeroCard, StageTrack, seededWords } from "./Hero";
export { HowItWorks, LifecycleDiagram, lifecycleSteps, type Stage } from "./HowItWorks";
export { LiveNumbers } from "./LiveNumbers";
export { Audiences, Closing, Faq, type FaqItem, faqItems, Safety, WhyMonad } from "./Sections";
export { blockTimeWords, PROTOCOL, PROTOCOL_URL, priceWords, ruleWords, usdcWords } from "./words";

/**
 * The landing page: hero with the most active market, live numbers from the chain, how it works,
 * who it is for, safety, why Monad, questions, and a last call to action. Every figure on it is read
 * from the chain on each refresh or left out.
 */
export function Landing({ live }: { live: LandingRead }) {
  const data = live.status === "ok" ? live.data : null;
  return (
    <>
      <Hero live={live} />
      <LiveNumbers live={live} />
      <HowItWorks rule={data?.rule ?? data?.featured?.rule ?? null} stats={data?.stats ?? null} />
      <Audiences />
      <Safety vault={data?.vault ?? null} />
      <WhyMonad msPerBlock={data?.msPerBlock ?? null} />
      <Faq />
      <Closing />
    </>
  );
}
