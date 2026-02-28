FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN npm install --omit=dev

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=8080
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data && chown -R nodejs:nodejs /data
USER nodejs
EXPOSE 8080
ENV DATA_DIR=/data
CMD ["sh", "-c", "node server/scripts/init-db.js && node server/index.js"]
