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
