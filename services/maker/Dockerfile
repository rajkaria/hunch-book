# Hunch Book maker bot. Build from the repository root (the pnpm workspace):
#   docker build -f services/maker/Dockerfile -t hunch-book-maker .
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
COPY services/maker/package.json services/maker/
# Only the maker and what it depends on (@hunch-book/shared, @hunch-book/deployments).
RUN pnpm install --frozen-lockfile --filter "@hunch-book/maker..."

COPY packages/shared/tsconfig.json packages/shared/tsconfig.build.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY services/maker/tsconfig.json services/maker/tsconfig.build.json services/maker/
COPY services/maker/src services/maker/src
RUN pnpm --filter @hunch-book/shared build

RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production \
    MAKER_HEALTH_FILE=/data/maker-health.json \
    MAKER_HEALTH_PORT=8080
EXPOSE 8080
WORKDIR /app/services/maker

# `tsx src/main.ts run`, as one node process, so SIGTERM reaches the bot directly: it cancels every
# order and withdraws its margin before it exits. Give it time to do so (see ops/README.md).
CMD ["node", "--import", "tsx", "src/main.ts", "run"]
