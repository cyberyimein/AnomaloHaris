# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend

WORKDIR /src/frontend

COPY frontend/package.json frontend/package-lock.json ./

RUN npm ci

COPY frontend ./
RUN npm run build

FROM python:3.12-slim AS runtime

ARG ANOMALO_INSTALL_EXTRAS=buddy,stocks,vision

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ANOMALO_ENV=production \
    ANOMALO_BUDDY_AUDIO_AI_ENABLED=false \
    ANOMALO_BUDDY_AUDIO_DEBUG_STORAGE=off \
    PYTHON_SANDBOX_ENABLED=true \
    FRUITSPY_PYTHON_TOOL_BASE_URL=http://127.0.0.1:8848

WORKDIR /app

RUN set -eux; \
    apt_packages=""; \
    case ",$ANOMALO_INSTALL_EXTRAS," in \
        *,audio,*) apt_packages="$apt_packages ffmpeg libsndfile1" ;; \
    esac; \
    case ",$ANOMALO_INSTALL_EXTRAS," in \
        *,vision,*) apt_packages="$apt_packages libgl1 libglib2.0-0" ;; \
    esac; \
    if [ -n "$apt_packages" ]; then \
        apt-get update; \
        apt-get install -y --no-install-recommends $apt_packages; \
        rm -rf /var/lib/apt/lists/*; \
    fi

COPY pyproject.toml README.md ./
COPY agent-backend ./agent-backend
COPY buddy-backend ./buddy-backend
COPY stock-backend ./stock-backend
COPY --from=frontend /src/agent-backend/app/frontend ./agent-backend/app/frontend

RUN if [ -z "$ANOMALO_INSTALL_EXTRAS" ] || [ "$ANOMALO_INSTALL_EXTRAS" = "none" ]; then \
        pip install --no-cache-dir .; \
    else \
        pip install --no-cache-dir ".[${ANOMALO_INSTALL_EXTRAS}]"; \
    fi

EXPOSE 8000 8787

ENV PYTHONPATH=/app/agent-backend:/app/buddy-backend:/app/stock-backend

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
