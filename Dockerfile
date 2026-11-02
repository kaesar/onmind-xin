FROM oven/bun:1.4 AS base
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY src ./src
ENV XIN_ENV=production PORT=8788 XIN_JSON_PATH=/data/xemails.json
EXPOSE 8788 1025
VOLUME ["/data"]
CMD ["bun", "src/dev.js"]
