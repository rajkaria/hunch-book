import type { LandingRead } from "@/lib/chain/landing";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { LiveNumbers } from "./LiveNumbers";
import { OnKuru } from "./OnKuru";
import { Audiences, Closing, Faq, Safety, WhyMonad } from "./Sections";

export { ContractLinks, Hero, HeroCard, StageTrack, seededWords } from "./Hero";
export {
  HowItWorks,
  LifecycleDiagram,
  lifecycleSteps,
  networkRuleFacts,
  rulesDiffer,
  type Stage,
} from "./HowItWorks";
export { LiveNumbers } from "./LiveNumbers";
export { KURU_URL, type KuruCard, kuruCards, OnKuru } from "./OnKuru";
export { Audiences, Closing, Faq, type FaqItem, faqItems, kuruFaqNotes, Safety, WhyMonad } from "./Sections";
export { blockTimeWords, PROTOCOL, PROTOCOL_URL, priceWords, ruleWords, usdcWords } from "./words";

/**
 * The landing page: hero with the most active market, live numbers from the chain, Kuru (the venue for
 * every new market), how it works, who it is for, safety, why Monad, questions, and a last call to action.
 * Every figure on it is read from the chain on each refresh or left out.
 */
export function Landing({ live }: { live: LandingRead }) {
  const data = live.status === "ok" ? live.data : null;
  return (
    <>
      <Hero live={live} />
      <LiveNumbers live={live} />
      <OnKuru />
      <HowItWorks
        rule={data?.rule ?? data?.featured?.rule ?? null}
        rules={data?.rules ?? []}
        stats={data?.stats ?? null}
      />
      <Audiences />
      <Safety vault={data?.vault ?? null} />
      <WhyMonad msPerBlock={data?.msPerBlock ?? null} />
      <Faq />
      <Closing />
    </>
  );
}
