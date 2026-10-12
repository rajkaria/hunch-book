# Hunch Book watchdog. Build from the repository root (the pnpm workspace):
#   docker build -f services/watchdog/Dockerfile -t hunch-book-watchdog .
# One run reads the chain, checks it, posts to WATCHDOG_WEBHOOK when something is wrong, and exits: run it
# on a schedule (railway.json sets a cron). Only the files named below enter the image.
FROM node:22-slim

ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY deployments/package.json deployments/monad-testnet.json deployments/monad-mainnet.json deployments/
COPY packages/shared/package.json packages/shared/
COPY services/watchdog/package.json services/watchdog/
RUN pnpm install --frozen-lockfile --filter "@hunch-book/watchdog..."

COPY packages/shared/tsconfig.json packages/shared/tsconfig.build.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY services/watchdog/tsconfig.json services/watchdog/tsconfig.build.json services/watchdog/
COPY services/watchdog/src services/watchdog/src
RUN pnpm --filter @hunch-book/shared build

USER node
ENV NODE_ENV=production
WORKDIR /app/services/watchdog
CMD ["node", "--import", "tsx", "src/main.ts"]
