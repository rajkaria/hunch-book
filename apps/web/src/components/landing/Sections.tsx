import { addressUrl, CREATOR_SHARE_BPS, deployments } from "@hunch-book/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Address } from "viem";
import type { VaultBooks } from "@/lib/chain/landing";
import { appDeployment, appNetwork, appNetworkLabel, isDeployed, REPO_URL } from "@/lib/config";
import { TESTNET_MONEY } from "@/lib/copy";
import { formatBpsPercent, formatUsdc } from "@/lib/format";
import { AddressLink, ButtonLink, LineIcon } from "../ui";
import s from "./landing.module.css";
import { blockTimeWords, PROTOCOL, PROTOCOL_URL } from "./words";

function SectionHead({
  eyebrow,
  title,
  id,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  id: string;
  children?: ReactNode;
}) {
  return (
    <div className={s.sectionHead}>
      <p className={s.eyebrow}>
        <span className={s.eyebrowMark} aria-hidden="true" />
        {eyebrow}
      </p>
      <h2 className={s.h2} id={id}>
        {title}
      </h2>
      {children ? <p className={s.lede}>{children}</p> : null}
    </div>
  );
}

const icons: Record<string, ReactNode> = {
  trader: (
    <LineIcon>
      <path d="M3 17l5-5 4 4 8-8" />
      <path d="M15 8h5v5" />
    </LineIcon>
  ),
  creator: (
    <LineIcon>
      <path d="M12 5v14M5 12h14" />
      <rect x="3" y="3" width="18" height="18" rx="5" />
    </LineIcon>
  ),
  maker: (
    <LineIcon>
      <path d="M4 7h10M4 12h16M4 17h7" />
      <circle cx="18" cy="7" r="2" />
      <circle cx="15" cy="17" r="2" />
    </LineIcon>
  ),
  book: (
    <LineIcon>
      <path d="M4 6h7M4 10h5M4 14h8M4 18h4" />
      <path d="M14 6h6M16 10h4M13 14h7M17 18h3" />
    </LineIcon>
  ),
  history: (
    <LineIcon>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </LineIcon>
  ),
  bolt: (
    <LineIcon>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </LineIcon>
  ),
  shield: (
    <LineIcon>
      <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </LineIcon>
  ),
  void: (
    <LineIcon>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </LineIcon>
  ),
  code: (
    <LineIcon>
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />
    </LineIcon>
  ),
};

// ---------- who it's for ----------

export function Audiences() {
  const creatorShare = formatBpsPercent(CREATOR_SHARE_BPS);
  const cards = [
    {
      key: "trader",
      eyebrow: "For traders",
      title: "Hedge funding. Sell before the answer.",
      points: [
        "Get paid back if funding on Perpl stays high this week, from a market that settles on Perpl's own numbers.",
        "Once a market graduates, sell your YES or NO on its Kuru book whenever you like.",
        "You can lose at most what you put in. No margin, no liquidation.",
      ],
      cta: { href: "/markets", label: "Browse markets", external: false },
    },
    {
      key: "creator",
      eyebrow: "For creators",
      title: "Start the market your people want.",
      points: [
        "Pick a template the chain can answer: Perpl funding or a Chainlink price.",
        "Make the first stake and share the link. The pool works from that first dollar.",
        `Earn ${creatorShare} of Hunch Book's fee on every market you start, withdrawn onchain.`,
      ],
      cta: { href: "/create", label: "Start a market", external: false },
    },
    {
      key: "maker",
      eyebrow: "For makers",
      title: "Quote a fully backed binary.",
      points: [
        "1 YES + 1 NO is always backed by 1 USDC. Mint and merge sets at exactly 1 USDC, with no fee.",
        "The settlement rule is fixed onchain when the market is created.",
        "Start from our open-source maker bot. Its fills are counted as ours, apart from yours.",
      ],
      cta: { href: `${REPO_URL}/tree/main/services/maker`, label: "The maker bot", external: true },
    },
  ];
  return (
    <section className={s.section} aria-labelledby="who-title">
      <div className={s.wrap}>
        <SectionHead
          eyebrow="Who it's for"
          title="Built for the people on both sides of a book"
          id="who-title"
        >
          A Perpl trader paying funding is the first person we built for. Creators and makers are what keep
          the markets full.
        </SectionHead>
        <ul className={s.audiences}>
          {cards.map((card) => (
            <li className={`${s.audience} ${s[`audience-${card.key}`] ?? ""}`} key={card.key}>
              <span className={s.audienceIcon}>{icons[card.key]}</span>
              <p className={s.audienceEyebrow}>{card.eyebrow}</p>
              <h3 className={s.audienceTitle}>{card.title}</h3>
              <ul className={s.checks}>
                {card.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <ButtonLink
                href={card.cta.href}
                external={card.cta.external}
                size="sm"
                arrow
                className={s.audienceCta}
              >
                {card.cta.label}
              </ButtonLink>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---------- safety ----------

interface Role {
  who: string;
  address?: Address;
  can: string[];
  cannot: string[];
}

export function Safety({ vault }: { vault: VaultBooks | null }) {
  const guardian = appDeployment.hunchBook.guardian;
  const vaultAddress = appDeployment.hunchBook.vault;
  const roles: Role[] = [
    {
      who: "Anyone",
      can: [
        "create a market from a template",
        "stake, graduate a pool that meets its rule",
        "settle after close, void after the deadline",
        "mint, merge and redeem",
      ],
      cannot: ["set an outcome", "move anyone else's funds"],
    },
    {
      who: "The guardian",
      address: guardian,
      can: ["pause new markets", "pause graduation", "add a template", "set caps for markets created later"],
      cannot: [
        "pause settlement, redemption, merges or refunds",
        "change a market that exists",
        "set an outcome",
        "move funds",
      ],
    },
  ];
  return (
    <section className={s.section} aria-labelledby="safety-title">
      <div className={s.wrap}>
        <SectionHead eyebrow="Safety" title="Your money does not depend on trusting us" id="safety-title">
          The rules live in the contracts. Here is who can do what, and what happens when something goes
          wrong.
        </SectionHead>

        <div className={s.roles}>
          {roles.map((role) => (
            <div className={s.role} key={role.who}>
              <h3 className={s.roleWho}>
                {role.who}
                {role.address ? (
                  <span className={s.roleAddress}>
                    <AddressLink address={role.address} />
                  </span>
                ) : null}
              </h3>
              <div className={s.roleCols}>
                <div>
                  <p className={s.roleCan}>Can</p>
                  <ul className={s.roleList}>
                    {role.can.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className={s.roleCannot}>Cannot</p>
                  <ul className={`${s.roleList} ${s.roleListNo}`}>
                    {role.cannot.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ))}
          <div className={`${s.role} ${s.roleNobody}`}>
            <h3 className={s.roleWho}>Nobody</h3>
            <p className={s.nobodyLine}>sets an outcome by hand.</p>
            <p className={s.roleText}>
              Not us, not the guardian, not the creator. A resolver contract reads the answer from Perpl or
              Chainlink, and anyone can check the read.
            </p>
            <a className={s.stageMore} href={PROTOCOL.access} target="_blank" rel="noreferrer">
              Access control in the protocol<span aria-hidden="true"> ↗</span>
            </a>
          </div>
        </div>

        <ul className={s.safetyCards}>
          <li className={s.safetyCard}>
            <span className={s.safetyIcon}>{icons.shield}</span>
            <h3 className={s.cardHeading}>Fully backed, checked after every call</h3>
            <p className={s.cardText}>
              Until settlement, every YES and NO pair is backed by 1 USDC in the{" "}
              {vaultAddress ? (
                <a href={addressUrl(appDeployment, vaultAddress)} target="_blank" rel="noreferrer">
                  vault
                </a>
              ) : (
                "vault"
              )}
              . The vault must hold at least what it owes after every call, including inside flash loans.
            </p>
            {vault ? (
              <p className={s.solvency}>
                <span>
                  Holds <span className="mono">{formatUsdc(vault.balance)}</span>
                </span>
                <span>
                  Owes <span className="mono">{formatUsdc(vault.obligations)}</span>
                </span>
                <span className="subtle">USDC, read just now</span>
              </p>
            ) : null}
            <a className={s.stageMore} href={PROTOCOL.invariants} target="_blank" rel="noreferrer">
              The invariants<span aria-hidden="true"> ↗</span>
            </a>
          </li>
          <li className={s.safetyCard}>
            <span className={s.safetyIcon}>{icons.void}</span>
            <h3 className={s.cardHeading}>If the source never answers</h3>
            <p className={s.cardText}>
              A market voids only if its resolver gets no answer within 7 days of close. A pool then refunds
              every stake in full. After graduation, every YES and NO redeems for 0.50 USDC, which is not a
              refund if you bought at another price.
            </p>
            <a className={s.stageMore} href={PROTOCOL.void} target="_blank" rel="noreferrer">
              Void terms<span aria-hidden="true"> ↗</span>
            </a>
          </li>
          <li className={s.safetyCard}>
            <span className={s.safetyIcon}>{icons.code}</span>
            <h3 className={s.cardHeading}>Tested in the open</h3>
            <p className={s.cardText}>
              Every contract is public, with unit, fuzz and invariant tests, and fork tests against live Kuru,
              Perpl and Chainlink contracts. The known limits are written down.
            </p>
            <a className={s.stageMore} href={PROTOCOL.limitations} target="_blank" rel="noreferrer">
              Known limitations<span aria-hidden="true"> ↗</span>
            </a>
          </li>
        </ul>
      </div>
    </section>
  );
}

// ---------- why Monad ----------

export function WhyMonad({ msPerBlock }: { msPerBlock: number | null }) {
  const points = [
    {
      icon: icons.book,
      title: "Kuru: an order book that lives onchain",
      body: "A pool graduates into a real YES/USDC book that anyone can quote, not into a matching engine on our server.",
    },
    {
      icon: icons.history,
      title: "Perpl: funding history you can read by block",
      body: "Perpl keeps cumulative funding onchain, so a market settles from it with no oracle committee and no keeper of ours deciding.",
    },
    {
      icon: icons.bolt,
      title: "Fast, cheap blocks",
      body:
        msPerBlock !== null
          ? `A block every ${blockTimeWords(msPerBlock)} on average, measured on chain just now, and low fees make a separate order book for each small market affordable.`
          : "Fast blocks and low fees make a separate order book for each small market affordable.",
    },
  ];
  return (
    <section className={s.section} aria-labelledby="monad-title">
      <div className={s.wrap}>
        <SectionHead
          eyebrow="Why Monad"
          title="It only works where the book and the data are both onchain"
          id="monad-title"
        />
        <ul className={s.monad}>
          {points.map((p) => (
            <li className={s.monadCard} key={p.title}>
              <span className={s.monadIcon}>{p.icon}</span>
              <h3 className={s.cardHeading}>{p.title}</h3>
              <p className={s.cardText}>{p.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---------- FAQ ----------

export interface FaqItem {
  q: string;
  a: ReactNode;
}

export function faqItems(): FaqItem[] {
  const mainnetLive = isDeployed(deployments["monad-mainnet"]);
  const testnetLive = isDeployed(deployments["monad-testnet"]);
  const creatorShare = formatBpsPercent(CREATOR_SHARE_BPS);
  return [
    {
      q: "What are the fees?",
      a: (
        <>
          In a pool, winners pay 2% of their winnings, never more than the losing side put in. After
          graduation, each winning token redeems for 1 USDC less a fee fixed at graduation, at most 1.94
          cents. Kuru's own trading fees go to Kuru. Minting, merging and void refunds are free.{" "}
          {creatorShare} of Hunch Book's fee goes to the market's creator.{" "}
          <a href={PROTOCOL.fees} target="_blank" rel="noreferrer">
            Fee table
          </a>
          .
        </>
      ),
    },
    {
      q: "What happens if the data source fails?",
      a: "The market voids if its resolver cannot get an answer within 7 days after the window closes. While it is a pool, every stake comes back in full. After graduation, every YES and every NO token redeems for 0.50 USDC, so someone who bought YES at 0.80 loses 0.30 per token. Templates read history that stays readable, so voids should be rare.",
    },
    {
      q: "Can I sell before the answer?",
      a: "Not from a pool: stakes are final until settlement, which is what keeps a pool safe without a market maker. Once a market graduates, you can sell YES or NO on its Kuru book at any time until the window closes.",
    },
    {
      q: "Who is on the other side of my trade?",
      a: "In a pool, everyone who staked the other side. On a book, whoever has orders on Kuru, and anyone can quote. Until outside makers join, many quotes come from our own open-source maker bot. Its address is published and every fill against it is counted as ours.",
    },
    {
      q: "Who decides the outcome?",
      a: "No person. Each market names a resolver contract and the exact data it reads: Perpl's funding history or a Chainlink price round. After the window closes, anyone can call settle, and the resolver answers from the chain or not at all.",
    },
    {
      q: "What is live today?",
      a: (
        <>
          {testnetLive
            ? "On Monad testnet: the contracts, pools, graduation into Kuru books, and trading YES and NO through the router. "
            : "Nothing is deployed yet. "}
          {appNetwork === "monad-testnet" ? `${TESTNET_MONEY} ` : null}
          {mainnetLive ? "Monad mainnet is live with real USDC." : "Mainnet with real USDC is planned."} Every
          address is in{" "}
          <a href={`${REPO_URL}/blob/main/deployments/${appNetwork}.json`} target="_blank" rel="noreferrer">
            deployments/{appNetwork}.json
          </a>
          .
        </>
      ),
    },
  ];
}

export function Faq() {
  return (
    <section className={s.section} aria-labelledby="faq-title">
      <div className={`${s.wrap} ${s.faqGrid}`}>
        <div className={s.faqIntro}>
          <SectionHead eyebrow="Fair questions" title="A little clarity goes a long way" id="faq-title" />
          <p className={s.faqAside}>
            The full rules are in the{" "}
            <a href={PROTOCOL_URL} target="_blank" rel="noreferrer">
              protocol spec
            </a>
            .
          </p>
        </div>
        <div className={s.faqList}>
          {faqItems().map((item) => (
            <details className={s.faqItem} key={item.q}>
              <summary className={s.faqQ}>
                <span>{item.q}</span>
                <span className={s.faqIcon} aria-hidden="true" />
              </summary>
              <div className={s.faqA}>{item.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- closing ----------

export function Closing() {
  return (
    <section className={s.closingSection} aria-labelledby="closing-title">
      <div className={s.wrap}>
        <div className={s.closing}>
          <div className={s.closingGlow} aria-hidden="true" />
          <p className={s.eyebrow}>
            <span className={s.eyebrowMark} aria-hidden="true" />
            {appNetworkLabel}
          </p>
          <h2 className={s.closingTitle} id="closing-title">
            What's your hunch?
          </h2>
          <p className={s.closingSub}>Find a market and take a side, or start the one you wish existed.</p>
          <div className={s.ctas}>
            <ButtonLink href="/markets" variant="primary" size="lg" arrow>
              Browse markets
            </ButtonLink>
            <ButtonLink href="/create" size="lg">
              Start a market
            </ButtonLink>
          </div>
          <p className={s.closingNote}>
            Predictions involve risk. You can lose what you put in.{" "}
            <Link href="/proof">See what is counted, and how</Link>.
          </p>
        </div>
      </div>
    </section>
  );
}
