FROM node:24-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV BYOK_STORE_PATH=/app/data/byok-credentials.json
ENV HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/openrouter-facade/package.json ./apps/openrouter-facade/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/opencode-plugin-pippit/package.json ./packages/opencode-plugin-pippit/package.json
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/apps/openrouter-facade/dist ./apps/openrouter-facade/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
RUN mkdir -p /app/data \
  && chown node:node /app/data \
  && chmod 700 /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port = process.env.PORT ?? '3000'; fetch('http://127.0.0.1:' + port + '/health').then(async (response) => { await response.body?.cancel(); if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]
CMD ["node", "apps/openrouter-facade/dist/server.js"]
