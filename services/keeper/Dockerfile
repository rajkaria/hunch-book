# Hunch Book keeper. Build from the repository root (the pnpm workspace):
#   docker build -f services/keeper/Dockerfile -t hunch-book-keeper .
# Only the files named below enter the image: never .env, never internal/.
FROM node:22-slim

ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm at the version pinned in package.json's packageManager field.
RUN corepack enable
WORKDIR /app

# The workspace manifests and the lockfile first, so the dependency layer is cached.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY deployments/package.json deployments/monad-testnet.json deployments/monad-mainnet.json deployments/
COPY packages/shared/package.json packages/shared/
COPY services/keeper/package.json services/keeper/
# Only the keeper and what it depends on (@hunch-book/shared, @hunch-book/deployments).
RUN pnpm install --frozen-lockfile --filter "@hunch-book/keeper..."

COPY packages/shared/tsconfig.json packages/shared/tsconfig.build.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY services/keeper/tsconfig.json services/keeper/tsconfig.build.json services/keeper/
COPY services/keeper/src services/keeper/src
RUN pnpm --filter @hunch-book/shared build

# State and health live in /data: mount a volume there to keep scan cursors across restarts.
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production \
    KEEPER_STATE_FILE=/data/keeper-state.json \
    KEEPER_HEALTH_FILE=/data/keeper-health.json \
    KEEPER_HEALTH_PORT=8080
EXPOSE 8080
WORKDIR /app/services/keeper

# `tsx src/main.ts run`, as one node process, so SIGTERM reaches the keeper directly.
CMD ["node", "--import", "tsx", "src/main.ts", "run"]
