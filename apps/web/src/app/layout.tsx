import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Footer } from "@/components/layout/Footer";
import { Header } from "@/components/layout/Header";
import { Providers } from "@/components/Providers";
import { SITE_URL } from "@/lib/config";
import "./globals.css";

const DESCRIPTION =
  "Prediction markets on Monad that start as USDC pools, graduate to Kuru's onchain order book, and settle by reading the chain.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Hunch Book", template: "%s | Hunch Book" },
  description: DESCRIPTION,
  applicationName: "Hunch Book",
  openGraph: { title: "Hunch Book", description: DESCRIPTION, siteName: "Hunch Book", type: "website" },
  twitter: { card: "summary_large_image", title: "Hunch Book", description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: "#0e0f0c",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Providers>
          <Header />
          <main id="main">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
