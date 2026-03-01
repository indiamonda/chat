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
CMD ["sh", "-c", "node server/scripts/init-db.js && node server/index.js"]
