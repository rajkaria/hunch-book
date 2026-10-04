"use client";

// Replaces the root layout when it fails, so it carries its own document and minimal styles.
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#0b0b0f",
          color: "#fafaf7",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <title>Something went wrong | Hunch Book</title>
        <main style={{ maxWidth: 480 }}>
          <p style={{ fontFamily: "ui-monospace, monospace", color: "#cbff5d", margin: 0 }}>HUNCH BOOK</p>
          <h1 style={{ fontSize: 24, margin: "12px 0" }}>Something went wrong</h1>
          <p style={{ color: "#b4b4ad", lineHeight: 1.5 }}>
            The app hit an error it could not recover from. Nothing was sent from your wallet.
            {error.digest ? ` Reference: ${error.digest}.` : ""}
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              marginTop: 16,
              padding: "10px 16px",
              background: "#cbff5d",
              color: "#0b0b0f",
              border: 0,
              borderRadius: 4,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
