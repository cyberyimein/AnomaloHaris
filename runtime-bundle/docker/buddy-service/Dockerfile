# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /src

COPY package.json package-lock.json tsconfig.base.json ./
COPY frontend/package.json ./frontend/package.json
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/node-host/package.json apps/node-host/tsconfig.json ./apps/node-host/
COPY apps/buddy-bridge/package.json apps/buddy-bridge/tsconfig.json ./apps/buddy-bridge/
COPY apps/buddy-service/package.json apps/buddy-service/tsconfig.json ./apps/buddy-service/

RUN npm ci --ignore-scripts

COPY apps/buddy-service ./apps/buddy-service
RUN npm run build --workspace @anomaloharis/buddy-service

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    BUDDY_HOST=0.0.0.0 \
    BUDDY_PORT=8765

WORKDIR /app

COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps/buddy-service/package.json ./apps/buddy-service/package.json
COPY --from=build /src/apps/buddy-service/dist ./apps/buddy-service/dist

EXPOSE 8765 8787

CMD ["node", "apps/buddy-service/dist/main.js"]
