FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
    tini \
    tzdata \
  && curl --fail --location --retry 3 \
    https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp \
    --output /usr/local/bin/yt-dlp \
  && echo "495be29ff4d9d4e9be7eabdfef225221e5d5282e77f2f505abc6dca80349f3fd  /usr/local/bin/yt-dlp" | sha256sum --check --strict \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && yt-dlp --version \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev

COPY src ./src
COPY README.md ./

RUN mkdir -p /app/data/downloads /app/cookies && chown -R node:node /app

USER node

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.HTTP_PORT||8080;require('http').get('http://127.0.0.1:'+p+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["npm", "start"]
