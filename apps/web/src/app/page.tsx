import { addressUrl, loadDeployment } from "@hunch-book/shared";

const testnet = loadDeployment("monad-testnet");

export default function Home() {
  const factory = testnet.hunchBook.factory;
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "72px 16px" }}>
      <p className="mono" style={{ color: "var(--accent)", margin: 0 }}>
        HUNCH BOOK
      </p>
      <h1 style={{ fontSize: 40, lineHeight: 1.1, margin: "16px 0" }}>
        Prediction markets that start as pools and graduate to an onchain order book.
      </h1>
      <p style={{ color: "var(--muted)", fontSize: 18, lineHeight: 1.5 }}>
        Stake USDC on yes or no. Once a pool proves demand, it becomes fully backed YES and NO tokens trading
        on Kuru, so you can sell before the answer. Markets settle by reading Monad, not a person.
      </p>
      <p style={{ marginTop: 32 }}>
        Status: <strong>building</strong>. Nothing is live yet.
        {factory ? (
          <>
            {" "}
            Testnet factory:{" "}
            <a className="mono" href={addressUrl(testnet, factory)}>
              {factory}
            </a>
          </>
        ) : null}
      </p>
      <p>
        <a href="https://github.com/rajkaria/hunch-book">Source and protocol design on GitHub</a>
      </p>
    </main>
  );
}
