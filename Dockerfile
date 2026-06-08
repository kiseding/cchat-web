# Stage 1: Build frontend
FROM node:22-alpine AS builder
WORKDIR /app
COPY packages/app/package.json packages/app/
RUN cd packages/app && npm install
COPY packages/app/src packages/app/src/
COPY packages/app/index.html packages/app/vite.config.ts packages/app/tsconfig.json packages/app/
RUN cd packages/app && npx vite build

# Stage 2: Runtime (server only)
FROM node:22-alpine
WORKDIR /app
COPY packages/server/package.json packages/server/
RUN cd packages/server && npm install
COPY packages/server/ packages/server/
COPY --from=builder /app/packages/app/dist packages/app/dist

EXPOSE 4096
ENV AUTH_TOKEN=cchat2web PORT=4096
CMD ["node", "--import", "tsx", "packages/server/index.ts"]
