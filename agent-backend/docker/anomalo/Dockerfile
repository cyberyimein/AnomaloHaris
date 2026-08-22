# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend

WORKDIR /src

COPY package.json package-lock.json tsconfig.base.json ./
COPY frontend/package.json ./frontend/package.json
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/node-host/package.json apps/node-host/tsconfig.json ./apps/node-host/

RUN npm ci --ignore-scripts

COPY packages/contracts ./packages/contracts
COPY apps/node-host ./apps/node-host
COPY frontend ./frontend
COPY agent-backend/config ./agent-backend/config
COPY agent-backend/skills ./agent-backend/skills
RUN npm run build --workspace @anomalo/contracts \
    && npm run build --workspace @anomalo/node-host \
    && npm run build --workspace frontend

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    ANOMALO_ENV=production \
    ANOMALO_ACKNOWLEDGE_PUBLIC_HOST=true \
    ANOMALO_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8000

WORKDIR /app

RUN mkdir -p /data

COPY --from=frontend /src/package.json ./package.json
COPY --from=frontend /src/node_modules ./node_modules
COPY --from=frontend /src/apps/node-host/package.json ./apps/node-host/package.json
COPY --from=frontend /src/apps/node-host/dist ./apps/node-host/dist
COPY --from=frontend /src/packages/contracts ./packages/contracts
COPY --from=frontend /src/agent-backend/app/frontend ./agent-backend/app/frontend
COPY --from=frontend /src/agent-backend/config ./agent-backend/config
COPY --from=frontend /src/agent-backend/skills ./agent-backend/skills

EXPOSE 8000

CMD ["node", "apps/node-host/dist/main.js"]
