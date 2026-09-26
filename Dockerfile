FROM node:22-alpine
RUN corepack enable
WORKDIR /repo
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @gmp/web build
ENV NODE_ENV=production
