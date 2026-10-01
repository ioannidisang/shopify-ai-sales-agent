FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm check

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
USER node
EXPOSE 3000
# Run the same image as a separate one-off migration job with:
# node dist/apps/server/src/migrate.js
# Only that job receives MIGRATION_DATABASE_URL. Runtime receives scoped DATABASE_URL.
CMD ["node", "dist/apps/server/src/index.js"]
