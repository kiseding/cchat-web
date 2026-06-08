# Stage 1: Build frontend
FROM node:22-alpine AS frontend
WORKDIR /app
COPY packages/app/package.json packages/app/
RUN cd packages/app && npm install
COPY packages/app/src packages/app/src/
COPY packages/app/index.html packages/app/vite.config.ts packages/app/tsconfig.json packages/app/
RUN cd packages/app && npx vite build

# Stage 2: Build Go server
FROM golang:1.22-alpine AS backend
WORKDIR /app
COPY packages/server/go.mod packages/server/
COPY packages/server/main.go packages/server/
RUN cd packages/server && CGO_ENABLED=0 go build -o server main.go

# Stage 3: Runtime
FROM scratch
COPY --from=backend /app/packages/server/server /server
COPY --from=frontend /app/packages/app/dist /app/dist

EXPOSE 4096
ENV AUTH_TOKEN=cchat2web PORT=4096
CMD ["/server"]
