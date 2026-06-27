# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend

WORKDIR /src

COPY package.json package-lock.json vite.config.js ./
COPY frontend ./frontend
COPY app/static ./app/static

RUN npm ci
RUN npm run build

FROM python:3.12-slim AS runtime

ARG ANOMALO_INSTALL_EXTRAS=audio,buddy

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ANOMALO_ENV=production \
    ANOMALO_BUDDY_AUDIO_DEBUG_STORAGE=off

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY app ./app
COPY buddy ./buddy
COPY config ./config
COPY skills ./skills
COPY --from=frontend /src/app/frontend ./app/frontend

RUN if [ -z "$ANOMALO_INSTALL_EXTRAS" ] || [ "$ANOMALO_INSTALL_EXTRAS" = "none" ]; then \
        pip install --no-cache-dir .; \
    else \
        pip install --no-cache-dir ".[${ANOMALO_INSTALL_EXTRAS}]"; \
    fi

EXPOSE 8000 8787

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
