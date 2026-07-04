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
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/download/2025.06.30/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
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
