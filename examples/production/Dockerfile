FROM oven/bun:1.3.12 AS build

WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.base.json tsconfig.test.json ./
COPY packages ./packages
COPY examples/production ./examples/production
RUN bun install --frozen-lockfile
RUN bun run build && bun run --cwd examples/production build

FROM node:26-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/examples/production ./examples/production
COPY --from=build --chown=node:node /app/package.json ./package.json
CMD ["node", "--enable-source-maps", "examples/production/dist/main.js"]
