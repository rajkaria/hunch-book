# Hunch Book notifier. Build from the repository root (the pnpm workspace):
#   docker build -f services/notifier/Dockerfile -t hunch-book-notifier .
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
COPY services/notifier/package.json services/notifier/
# Only the notifier and what it depends on (@hunch-book/shared, @hunch-book/deployments).
RUN pnpm install --frozen-lockfile --filter "@hunch-book/notifier..."

COPY packages/shared/tsconfig.json packages/shared/tsconfig.build.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY services/notifier/tsconfig.json services/notifier/tsconfig.build.json services/notifier/
COPY services/notifier/src services/notifier/src
RUN pnpm --filter @hunch-book/shared build

# Subscriptions, state and health live in /data: mount a volume there so watches survive restarts.
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production \
    NOTIFIER_SUBSCRIPTIONS_FILE=/data/subscriptions.json \
    NOTIFIER_STATE_FILE=/data/notifier-state.json \
    NOTIFIER_HEALTH_FILE=/data/notifier-health.json \
    NOTIFIER_HEALTH_PORT=8080
EXPOSE 8080
WORKDIR /app/services/notifier

# `tsx src/main.ts run`, as one node process, so SIGTERM reaches the notifier directly.
CMD ["node", "--import", "tsx", "src/main.ts", "run"]
