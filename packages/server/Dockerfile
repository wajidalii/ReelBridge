# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# dev: used by docker-compose; bind-mounts the repo and runs tsx watch.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS dev
WORKDIR /app

# ffprobe/ffmpeg: used to extract duration/width/height from uploaded media (#17).
RUN apk add --no-cache ffmpeg

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

EXPOSE 4000

CMD ["npm", "run", "dev:server"]

# ---------------------------------------------------------------------------
# build: compiles every workspace the API depends on.
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
COPY packages/server packages/server
RUN npm run build --workspace=@reelbridge/shared \
 && npm run build --workspace=@reelbridge/platform-facebook \
 && npm run build --workspace=@reelbridge/platform-instagram \
 && npm run build --workspace=@reelbridge/platform-youtube \
 && npm run build --workspace=@reelbridge/server \
 && npm prune --omit=dev

# ---------------------------------------------------------------------------
# prod: minimal runtime image, non-root, migrations run on start.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg tini
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
COPY --from=build /app/packages/server/package.json packages/server/package.json
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/src/db/migrations packages/server/dist/db/migrations
COPY packages/server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:4000/api/ready >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "packages/server/dist/server.js"]
