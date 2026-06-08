FROM oven/bun:1-alpine

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
COPY packages/server/package.json packages/server/
COPY packages/app/package.json packages/app/
RUN bun install

# Copy source
COPY . .

# Claude Code CLI (optional, needs API key at runtime)
# RUN bun add -g @anthropic-ai/claude-code

EXPOSE 4096 5173

ENV AUTH_TOKEN=cchat2web
ENV PORT=5173

CMD ["sh", "-c", "cd /app/packages/server && bun run index.ts & sleep 2 && cd /app/packages/app && bun run dev --host"]
