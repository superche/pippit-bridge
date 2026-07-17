FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV BYOK_STORE_PATH=/app/data/byok-credentials.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data \
  && chown node:node /app/data \
  && chmod 700 /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "dist/server.js"]
