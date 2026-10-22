# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# dev: used by docker-compose; bind-mounts the repo and runs tsx watch.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS dev
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/platforms/facebook/package.json packages/platforms/facebook/package.json
COPY packages/platforms/instagram/package.json packages/platforms/instagram/package.json
COPY packages/platforms/youtube/package.json packages/platforms/youtube/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/client/package.json packages/client/package.json

RUN npm install

COPY . .

CMD ["npm", "run", "dev:worker"]

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/platforms/facebook/package.json packages/platforms/facebook/package.json
COPY packages/platforms/instagram/package.json packages/platforms/instagram/package.json
COPY packages/platforms/youtube/package.json packages/platforms/youtube/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/client/package.json packages/client/package.json
RUN npm ci --ignore-scripts
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/platforms packages/platforms
COPY packages/worker packages/worker
RUN npm run build --workspace=@reelbridge/shared \
 && npm run build --workspace=@reelbridge/platform-facebook \
 && npm run build --workspace=@reelbridge/platform-instagram \
 && npm run build --workspace=@reelbridge/platform-youtube \
 && npm run build --workspace=@reelbridge/worker \
 && npm prune --omit=dev

# ---------------------------------------------------------------------------
# prod
# ---------------------------------------------------------------------------
FROM node:20-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/platforms/facebook/package.json packages/platforms/facebook/package.json
COPY --from=build /app/packages/platforms/facebook/dist packages/platforms/facebook/dist
COPY --from=build /app/packages/platforms/instagram/package.json packages/platforms/instagram/package.json
COPY --from=build /app/packages/platforms/instagram/dist packages/platforms/instagram/dist
COPY --from=build /app/packages/platforms/youtube/package.json packages/platforms/youtube/package.json
COPY --from=build /app/packages/platforms/youtube/dist packages/platforms/youtube/dist
COPY --from=build /app/packages/worker/package.json packages/worker/package.json
COPY --from=build /app/packages/worker/dist packages/worker/dist
RUN chown -R node:node /app
USER node
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:4001/readyz >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/worker/dist/worker.js"]
