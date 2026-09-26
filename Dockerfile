ARG NODE_IMAGE=node:latest
FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PNPM_VERSION=10.30.2
WORKDIR /repo
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_registry=${NPM_REGISTRY}
# Newer Node images no longer bundle corepack, so install the pinned pnpm with npm.
RUN npm install -g pnpm@${PNPM_VERSION}
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @gmp/web build
ENV NODE_ENV=production
