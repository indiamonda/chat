# Use Debian-based image so better-sqlite3 prebuilt binaries work (Alpine/musl has no prebuilds)
FROM node:20-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
COPY scripts ./scripts
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv make g++ git && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /app/.schoology-venv
COPY schoology-requirements.txt ./
RUN /app/.schoology-venv/bin/pip install --no-cache-dir -r schoology-requirements.txt
COPY schoology/ ./schoology/
RUN npm install --omit=dev

# Clone schoology-mcp for the Flask server
RUN git clone https://github.com/dajun666/schoology-mcp.git /app/schoology-mcp && \
    python3 -m venv /app/schoology-mcp/.venv && \
    /app/schoology-mcp/.venv/bin/pip install --no-cache-dir -r /app/schoology-mcp/requirements.txt && \
    rm -rf /app/schoology-mcp/.git

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=8080
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Socket.IO browser bundle for game.html (/socket.io.min.js); file may be untracked in git
RUN cp -f node_modules/socket.io/client-dist/socket.io.min.js public/socket.io.min.js
RUN mkdir -p /data && chown -R nodejs:nodejs /data
USER nodejs
EXPOSE 8080 8081
ENV DATA_DIR=/data
CMD ["sh", "-c", "[ -f ${DATA_DIR}/chat.db ] || node server/scripts/init-db.js; /app/.schoology-venv/bin/gunicorn -b 0.0.0.0:8081 --workers 1 --chdir /app/schoology server:app & exec node server/index.js"]
