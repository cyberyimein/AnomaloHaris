# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend

WORKDIR /src

COPY package.json package-lock.json tsconfig.base.json ./
COPY frontend/package.json ./frontend/package.json
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/node-host/package.json apps/node-host/tsconfig.json ./apps/node-host/
COPY apps/workflow-runtime/package.json apps/workflow-runtime/tsconfig.json ./apps/workflow-runtime/
COPY apps/buddy-bridge/package.json apps/buddy-bridge/tsconfig.json ./apps/buddy-bridge/
COPY apps/buddy-service/package.json apps/buddy-service/tsconfig.json ./apps/buddy-service/

RUN npm ci --ignore-scripts

COPY packages/contracts ./packages/contracts
COPY apps/node-host ./apps/node-host
COPY apps/workflow-runtime ./apps/workflow-runtime
COPY apps/buddy-bridge ./apps/buddy-bridge
COPY frontend ./frontend
COPY runtime-bundle/config ./runtime-bundle/config
COPY runtime-bundle/skills ./runtime-bundle/skills
RUN npm run build --workspace @anomaloharis/contracts \
    && npm run build --workspace @anomaloharis/workflow-runtime \
    && npm run build --workspace @anomaloharis/node-host \
    && npm run build --workspace @anomaloharis/buddy-bridge \
    && npm run build --workspace frontend

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    ANOMALOHARIS_ENV=production \
    ANOMALOHARIS_ACKNOWLEDGE_PUBLIC_HOST=true \
    ANOMALOHARIS_SERVICE_AUTH_REQUIRED=true \
    ANOMALOHARIS_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8000

WORKDIR /app

RUN mkdir -p /data

COPY --from=frontend /src/package.json ./package.json
COPY --from=frontend /src/node_modules ./node_modules
COPY --from=frontend /src/apps/node-host/package.json ./apps/node-host/package.json
COPY --from=frontend /src/apps/node-host/dist ./apps/node-host/dist
COPY --from=frontend /src/apps/workflow-runtime/package.json ./apps/workflow-runtime/package.json
COPY --from=frontend /src/apps/workflow-runtime/dist ./apps/workflow-runtime/dist
COPY --from=frontend /src/apps/buddy-bridge/package.json ./apps/buddy-bridge/package.json
COPY --from=frontend /src/apps/buddy-bridge/dist ./apps/buddy-bridge/dist
COPY --from=frontend /src/apps/buddy-service/package.json ./apps/buddy-service/package.json
COPY --from=frontend /src/packages/contracts ./packages/contracts
COPY --from=frontend /src/runtime-bundle/app/frontend ./runtime-bundle/app/frontend
COPY --from=frontend /src/runtime-bundle/config ./runtime-bundle/config
COPY --from=frontend /src/runtime-bundle/skills ./runtime-bundle/skills

EXPOSE 8000

CMD ["node", "apps/node-host/dist/main.js"]
