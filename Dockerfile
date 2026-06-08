FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/server/package.json packages/server/
COPY packages/app/package.json packages/app/
RUN bun install

COPY . .

# Build frontend
RUN cd packages/app && bun run build

EXPOSE 4096

ENV AUTH_TOKEN=cchat2web
ENV PORT=4096

CMD ["sh", "-c", "cd /app/packages/server && bun run index.ts"]
