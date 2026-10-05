# Kritvia web (Next.js standalone). Build from the MONOREPO ROOT so the workspace
# package @kritvia/shared-types is available:
#
#   docker build -f apps/web/Dockerfile -t kritvia-web .
#   docker run -p 3000:3000 -e KRITVIA_API_URL=http://api:8000 kritvia-web

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

# 1) dependencies (cached unless manifests change)
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @kritvia/web...

# 2) build. Business details shown in the site footer are baked in at build time.
FROM deps AS build
ARG NEXT_PUBLIC_COMPANY_ADDRESS=""
ARG NEXT_PUBLIC_COMPANY_GSTIN=""
ENV NEXT_PUBLIC_COMPANY_ADDRESS=$NEXT_PUBLIC_COMPANY_ADDRESS NEXT_PUBLIC_COMPANY_GSTIN=$NEXT_PUBLIC_COMPANY_GSTIN
COPY packages/shared-types packages/shared-types
COPY apps/web apps/web
RUN pnpm --filter @kritvia/web build

# 3) runtime: only the standalone server, static assets and public files
FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S -g 1001 kritvia && adduser -S -u 1001 -G kritvia kritvia
COPY --from=build --chown=kritvia:kritvia /repo/apps/web/.next/standalone ./
COPY --from=build --chown=kritvia:kritvia /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=kritvia:kritvia /repo/apps/web/public ./apps/web/public
USER kritvia
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
