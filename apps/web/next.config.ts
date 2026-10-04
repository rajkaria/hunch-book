import type { NextConfig } from "next";

const common = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // next dev would otherwise write AGENTS.md and CLAUDE.md into apps/web; the repo keeps its own at the root.
  agentRules: false,
  transpilePackages: ["@hunch-book/shared", "@hunch-book/sdk"],
  async headers() {
    return [
      {
        // Everything except the embeddable market cards.
        source: "/((?!embed/).*)",
        headers: [
          // A wallet app must not be framed by another site (clickjacking).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          ...common,
        ],
      },
      {
        // /embed/m/<address> is a read-only card with no wallet and no script, made to be framed
        // anywhere; its route sets a strict Content-Security-Policy with frame-ancestors *.
        source: "/embed/:path*",
        headers: common,
      },
    ];
  },
};

export default config;
