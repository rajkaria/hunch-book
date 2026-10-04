import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { Footer } from "@/components/layout/Footer";
import { Header } from "@/components/layout/Header";
import { Providers } from "@/components/Providers";
import { SITE_URL } from "@/lib/config";
import { DESCRIPTION } from "@/lib/copy";
import "./globals.css";

// Archivo, the main Hunch display face, self-hosted (SIL Open Font License, public/fonts/OFL.txt) so
// the build never fetches fonts from the network. Body text stays on the system stack.
const archivo = localFont({
  src: "../../public/fonts/archivo-latin-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-archivo",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Hunch Book", template: "%s | Hunch Book" },
  description: DESCRIPTION,
  applicationName: "Hunch Book",
  icons: { icon: "/icon.svg" },
  openGraph: { title: "Hunch Book", description: DESCRIPTION, siteName: "Hunch Book", type: "website" },
  twitter: { card: "summary_large_image", title: "Hunch Book", description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0f",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
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
