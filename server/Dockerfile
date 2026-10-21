# home-voice-agent のサーバー（Fly.io 用）
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY prompts ./prompts
COPY config/config.example.toml ./config/config.example.toml
# 設定は config.example.toml を土台にし、クラウド固有の値は fly.toml の環境変数で上書きする
ENV CONFIG_PATH=/app/config/config.example.toml DATA_DIR=/data
EXPOSE 8080 1883 8884/udp
CMD ["node_modules/.bin/tsx", "src/main.ts"]
