FROM node:22-alpine

WORKDIR /app

# Server deps (just hono)
COPY packages/server/package.json packages/server/
RUN cd packages/server && npm install --omit=dev

# Frontend: install + build (vite + solidjs + tailwind)
COPY packages/app/package.json packages/app/
RUN cd packages/app && npm install
COPY packages/app/src packages/app/src/
COPY packages/app/index.html packages/app/vite.config.ts packages/app/tsconfig.json packages/app/
RUN cd packages/app && npx vite build

# Server source (pure Node.js, no Bun needed)
COPY packages/server/index.mjs packages/server/claude-process.ts packages/server/session.ts packages/server/

EXPOSE 4096
ENV AUTH_TOKEN=cchat2web PORT=4096
CMD ["node", "packages/server/index.mjs"]
