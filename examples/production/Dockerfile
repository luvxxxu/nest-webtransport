FROM oven/bun:1.3.12 AS bun

FROM node:26-bookworm-slim AS source
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
# .dockerignore excludes host dependencies, build output, and local credentials.
COPY . .

FROM source AS build
RUN bun install --frozen-lockfile
RUN node scripts/check-runtime.mjs && bun run build && bun run --cwd examples/production build

FROM source AS dependencies
RUN bun install --production --frozen-lockfile

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/packages ./packages
COPY --from=dependencies --chown=node:node /app/examples/production ./examples/production
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/driver-rwebtransport/dist ./packages/driver-rwebtransport/dist
COPY --from=build --chown=node:node /app/packages/driver-rwebtransport/vendor ./packages/driver-rwebtransport/vendor
COPY --from=build --chown=node:node /app/packages/nest-webtransport/dist ./packages/nest-webtransport/dist
COPY --from=build --chown=node:node /app/packages/otel/dist ./packages/otel/dist
COPY --from=build --chown=node:node /app/packages/testing/dist ./packages/testing/dist
COPY --from=build --chown=node:node /app/examples/production/dist ./examples/production/dist
COPY --from=dependencies --chown=node:node /app/package.json ./package.json
USER node
CMD ["node", "--enable-source-maps", "examples/production/dist/main.js"]
