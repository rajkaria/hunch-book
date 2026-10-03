import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hunch Book",
  description:
    "Prediction markets on Monad that start as USDC pools, graduate to Kuru's onchain order book, and settle by reading the chain.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
