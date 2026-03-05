# Use Debian-based image so better-sqlite3 prebuilt binaries work (Alpine/musl has no prebuilds)
FROM node:20-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN npm install --omit=dev

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=8080
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data && chown -R nodejs:nodejs /data
USER nodejs
EXPOSE 8080
ENV DATA_DIR=/data
# Only run init-db when the database file doesn't exist (e.g. first deploy or new volume).
# This prevents overwriting an existing DB and resetting passwords to the default placeholder.
CMD ["sh", "-c", "[ -f ${DATA_DIR}/chat.db ] || node server/scripts/init-db.js; exec node server/index.js"]
